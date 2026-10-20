/**
 * The Screen recording: sessions/session-{id}/screen.ndjson.
 *
 * One `ScreenRecord` per line, keyframes interleaved with op batches, so any
 * moment can be restored from one keyframe plus the ops after it. The relay
 * asks the agent for a keyframe every `KEYFRAME_*` (see relay.ts); nothing
 * here decides when they happen, it only indexes them.
 *
 * Writes are buffered (op batches arrive every ~16 ms) and appended through a
 * per-session chain, so lines land on disk in order. Keyframe byte offsets are
 * indexed in memory — built once per session by scanning the file, then kept
 * up to date by appends — which is what makes a seek a single ranged read
 * instead of a replay from the beginning.
 *
 * Retention: SCREEN_LOG_MAX_BYTES per session. Over budget, the oldest whole
 * segments are dropped by rewriting the file from a later keyframe, so what is
 * left always starts at one.
 */
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import readline from 'node:readline';
import { SCREEN_LOG_FILE, SCREEN_LOG_MAX_BYTES, type ScreenRecord, type ScreenSegment } from '@bxconsole/protocol';

/** flush the write buffer at least this often */
const FLUSH_MS = 250;
/** …or as soon as it holds this much */
const FLUSH_BYTES = 256 * 1024;
/** after compaction, keep roughly this share of the budget so it does not run on every append */
const COMPACT_TARGET = 0.75;
/** how much of the recording a single seek/continue answer covers */
const SEGMENT_MS = 30_000;
/** hard ceiling on one answer, for a page that churns the DOM far faster than that */
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;

interface Keyframe {
  ts: number;
  offset: number;
  /** op batches recorded before this keyframe, so a seek knows its absolute position */
  before: number;
  /** the same count within this keyframe's own window */
  beforeInTab: number;
  /**
   * The window this keyframe came from. Only one window of a run streams at a
   * time, so a keyframe naming a different window than the one before it is
   * where the recording moves from one window to the next — which is all a
   * reader needs to be told which window they are watching.
   */
  tab?: string;
}

interface Index {
  /** byte offset of every keyframe line, oldest first */
  keyframes: Keyframe[];
  size: number;
  firstTs: number | null;
  lastTs: number | null;
  /** op batches in the whole file */
  batches: number;
  /**
   * First and last time each window appears, so the scrubber can be given one
   * window's recording rather than the whole run's. Only one window streams
   * at a time, so these are the stretches the recording is theirs.
   */
  tabs: Map<string, { first: number; last: number }>;
  /** op batches per window, so a per-window seek reports per-window numbers */
  tabBatches: Map<string, number>;
}

/** Widen a window's known extent to take in another of its lines. */
function noteTab(idx: Index, tab: string | undefined, ts: number): void {
  if (!tab) return;
  const seen = idx.tabs.get(tab);
  if (!seen) idx.tabs.set(tab, { first: ts, last: ts });
  else {
    if (ts < seen.first) seen.first = ts;
    if (ts > seen.last) seen.last = ts;
  }
}

interface Buffered {
  lines: string[];
  bytes: number;
  timer: NodeJS.Timeout | null;
}

export class ScreenLog {
  private readonly index = new Map<string, Index>();
  /** the in-flight (or finished) scan per session: one promise, so appends keep their order */
  private readonly indexing = new Map<string, Promise<Index>>();
  private readonly buffers = new Map<string, Buffered>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly dirFor: (sessionId: string) => string,
    /** per-session budget; the default is the one in the protocol */
    private readonly maxBytes: number = SCREEN_LOG_MAX_BYTES,
  ) {}

  private fileFor(sessionId: string): string {
    return path.join(this.dirFor(sessionId), SCREEN_LOG_FILE);
  }

  /** Queue a record. Lines are flushed in batches; the index moves forward right away. */
  append(sessionId: string, record: ScreenRecord): void {
    const line = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(line);

    void this.ensureIndex(sessionId).then((idx) => {
      // The window goes in here too, not only in the scan. A keyframe reaches
      // the index by this path for the whole life of a live run, and by the
      // scan only after a restart — so leaving it out here meant the window
      // was known for recordings read from disk and unknown for the one being
      // made, which is the one being watched.
      if (record.k === 1) {
        idx.keyframes.push({
          ts: record.ts,
          offset: idx.size,
          before: idx.batches,
          beforeInTab: record.tab ? (idx.tabBatches.get(record.tab) ?? 0) : idx.batches,
          ...(record.tab ? { tab: record.tab } : {}),
        });
      }
      // A cursor sample is neither: it annotates the recording without being a
      // change to it, so it must not move the batch counter the scrubber reads.
      else if (record.k === 0) {
        idx.batches++;
        if (record.tab) idx.tabBatches.set(record.tab, (idx.tabBatches.get(record.tab) ?? 0) + 1);
      }
      idx.size += bytes;
      idx.firstTs ??= record.ts;
      idx.lastTs = record.ts;
      noteTab(idx, record.tab, record.ts);

      const buf = this.buffers.get(sessionId) ?? { lines: [], bytes: 0, timer: null };
      this.buffers.set(sessionId, buf);
      buf.lines.push(line);
      buf.bytes += bytes;
      if (buf.bytes >= FLUSH_BYTES) {
        this.flush(sessionId);
      } else if (buf.timer === null) {
        buf.timer = setTimeout(() => this.flush(sessionId), FLUSH_MS);
      }
    });
  }

  /** What the recording covers, for the replay scrubber. */
  /**
   * The extent of the recording, or of one window of it.
   *
   * Only one window of a run streams at a time, so a window's recording is
   * the stretches where it was the one streaming. Asking for a window the
   * recording never names — an old recording, or one that never streamed —
   * gives the whole thing back, which is what there is to show.
   */
  async bounds(sessionId: string, tab?: string): Promise<{ start: number; end: number } | null> {
    const idx = await this.ensureIndex(sessionId);
    const own = tab ? idx.tabs.get(tab) : undefined;
    const first = own ? own.first : idx.firstTs;
    const last = own ? own.last : idx.lastTs;
    if (first === null || last === null || first === undefined || last === undefined) return null;
    return { start: first, end: Math.max(last, first + 1) };
  }

  /**
   * `seek`: the keyframe at or before `ts` and the ops recorded after it.
   * `continue`: the ops after `ts` alone, for playback that is already running.
   */
  async segment(sessionId: string, ts: number, mode: 'seek' | 'continue', tab?: string): Promise<ScreenSegment> {
    await this.flushAndSettle(sessionId);
    const idx = await this.ensureIndex(sessionId);
    const bounds = await this.bounds(sessionId, tab);
    // A window the recording never names is not a window to narrow to: an old
    // recording has no windows at all, and narrowing to one would show nothing.
    const only = tab && idx.tabs.has(tab) ? tab : undefined;
    const frames = only ? idx.keyframes.filter((k) => k.tab === only) : idx.keyframes;
    const changes = only ? (idx.tabBatches.get(only) ?? 0) : idx.batches;
    if (!bounds || frames.length === 0) return { bounds, batches: [], done: true, changes, from: 0 };

    const kf = keyframeAtOrBefore(frames, mode === 'seek' ? ts : ts) ?? frames[0]!;
    const until = (mode === 'seek' ? Math.max(ts, kf.ts) : ts) + SEGMENT_MS;

    // Which window this part of the recording belongs to, so the viewer can
    // say so rather than quietly showing a different one.
    const out: ScreenSegment = { bounds, batches: [], done: false, changes, from: only ? kf.beforeInTab : kf.before, ...(kf.tab ? { tab: kf.tab } : {}) };
    let bytes = 0;
    let reachedEnd = true;
    /** batches the caller does not already have; the window never cuts before the first one */
    let fresh = 0;

    for await (const { record, length } of this.readFrom(sessionId, kf.offset)) {
      // Another window's line. One window streams at a time, so these are the
      // stretches where this one was not the one recording; stepping over them
      // is what makes the playhead follow a single window.
      if (only && record.tab !== undefined && record.tab !== only) continue;
      if (record.k === 2) {
        // Carried along with whatever window the caller asked for; the viewer
        // sorts out which ones are at or before its playhead.
        (out.pointer ??= []).push({ ts: record.ts, ...record.pointer });
        continue;
      }
      if (record.k === 1) {
        // The first line read is the keyframe this seek starts from. Later ones
        // are redundant: the op stream between keyframes is complete on its own.
        if (mode === 'seek' && !out.snapshot && out.batches.length === 0) out.snapshot = record.snapshot;
        continue;
      }
      // `continue` is exclusive of what the caller has, but batches can share a
      // millisecond, so the boundary ones come along and the caller drops the
      // ones it already holds.
      if (mode === 'continue' && record.ts < ts) continue;
      // The window bounds how much comes back, but it must never come back with
      // nothing: a page can sit still for longer than one window, and an empty
      // answer would leave the player asking from the same spot forever. So the
      // first new batch is always included, however far ahead it is — that gap
      // is exactly what playback skips over.
      if ((record.ts > until && fresh > 0) || bytes > SEGMENT_MAX_BYTES) {
        reachedEnd = false;
        break;
      }
      bytes += length;
      out.batches.push({ ts: record.ts, ops: record.ops });
      if (mode === 'seek' || record.ts > ts) fresh++;
    }
    out.done = reachedEnd;
    return out;
  }

  /** Drop a session's recording from memory (its directory is removed elsewhere). */
  forget(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (buf?.timer) clearTimeout(buf.timer);
    this.buffers.delete(sessionId);
    this.index.delete(sessionId);
    this.indexing.delete(sessionId);
    this.chains.delete(sessionId);
  }

  // ------------------------------------------------------------------ writing

  private flush(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.lines.length === 0) return;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = null;
    const text = buf.lines.join('');
    buf.lines = [];
    buf.bytes = 0;
    this.enqueue(sessionId, async () => {
      const file = this.fileFor(sessionId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, text);
      await this.compactIfNeeded(sessionId);
    });
  }

  /** Make sure everything queued is on disk before a read. */
  private async flushAndSettle(sessionId: string): Promise<void> {
    // `append` only reaches the buffer once the scan it waits on has resolved,
    // so wait for that first: otherwise a read that arrives while the index is
    // still being built flushes nothing and answers from an empty file.
    await this.ensureIndex(sessionId);
    this.flush(sessionId);
    await (this.chains.get(sessionId) ?? Promise.resolve());
  }

  private enqueue(sessionId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task).catch((err: unknown) => console.warn('[bxconsole] screen log write failed', err));
    this.chains.set(sessionId, next);
  }

  /**
   * Over budget: rewrite the file from the oldest keyframe that brings it back
   * under the target, so the recording keeps its newest segments and still
   * starts at a keyframe.
   */
  private async compactIfNeeded(sessionId: string): Promise<void> {
    const idx = this.index.get(sessionId);
    if (!idx || idx.size <= this.maxBytes || idx.keyframes.length < 2) return;

    const target = this.maxBytes * COMPACT_TARGET;
    let cut = idx.keyframes[idx.keyframes.length - 1]!;
    for (const kf of idx.keyframes) {
      if (idx.size - kf.offset <= target) {
        cut = kf;
        break;
      }
    }
    if (cut.offset === 0) return;

    const file = this.fileFor(sessionId);
    const tmp = `${file}.compact`;
    await pipeline(createReadStream(file, { start: cut.offset }), createWriteStream(tmp));
    await fs.rename(tmp, file);

    /*
     * Drop the index rather than mend it.
     *
     * Compaction removes the front of the file, which moves every offset and
     * invalidates the counts kept per window as well as the ones kept for the
     * whole recording. Fixing those by hand means keeping four things in step
     * through a rewrite, and getting one wrong puts the scrubber somewhere the
     * file does not say. The next read rebuilds the lot from what survived —
     * which is less work than it sounds, the file having just been made
     * smaller, and is right by construction.
     */
    this.index.delete(sessionId);
    // The scan promise is what `ensureIndex` hands back, so the cached index
    // alone is not the cache.
    this.indexing.delete(sessionId);
  }

  // ------------------------------------------------------------------ reading

  private async *readFrom(sessionId: string, offset: number): AsyncGenerator<{ record: ScreenRecord; length: number }> {
    const file = this.fileFor(sessionId);
    try {
      await fs.access(file);
    } catch {
      return;
    }
    const rl = readline.createInterface({ input: createReadStream(file, { start: offset, encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record: ScreenRecord;
      try {
        record = JSON.parse(line) as ScreenRecord;
      } catch {
        continue; // torn last line after a crash
      }
      yield { record, length: line.length };
    }
  }

  /**
   * The keyframe index, scanned once. Every caller awaits the same promise, so
   * appends queued while the first scan runs keep the order they arrived in.
   */
  private ensureIndex(sessionId: string): Promise<Index> {
    const known = this.indexing.get(sessionId);
    if (known) return known;
    const pending = this.scan(sessionId).then((idx) => {
      this.index.set(sessionId, idx);
      return idx;
    });
    this.indexing.set(sessionId, pending);
    return pending;
  }

  /**
   * One pass over the file for keyframe offsets and the time bounds. Only each
   * line's first bytes are looked at (`{"k":1,"ts":…`), so a keyframe holding a
   * whole document is never parsed just to be indexed.
   */
  private async scan(sessionId: string): Promise<Index> {
    const idx: Index = { keyframes: [], size: 0, firstTs: null, lastTs: null, batches: 0, tabs: new Map(), tabBatches: new Map() };
    const file = this.fileFor(sessionId);
    try {
      idx.size = (await fs.stat(file)).size;
    } catch {
      return idx;
    }
    let base = 0;
    let leftover: Uint8Array = new Uint8Array(0);
    for await (const chunk of createReadStream(file)) {
      const buf = Buffer.from(leftover.length ? Buffer.concat([leftover, chunk as Uint8Array]) : (chunk as Uint8Array));
      let pos = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl === -1) break;
        const head = parseHead(buf, pos);
        if (head) {
          idx.firstTs ??= head.ts;
          idx.lastTs = head.ts;
          noteTab(idx, head.tab, head.ts);
          if (head.keyframe) {
            idx.keyframes.push({
              ts: head.ts,
              offset: base + pos,
              before: idx.batches,
              beforeInTab: head.tab ? (idx.tabBatches.get(head.tab) ?? 0) : idx.batches,
              ...(head.tab ? { tab: head.tab } : {}),
            });
          } else {
            idx.batches++;
            if (head.tab) idx.tabBatches.set(head.tab, (idx.tabBatches.get(head.tab) ?? 0) + 1);
          }
        }
        pos = nl + 1;
      }
      leftover = buf.subarray(pos);
      base += pos;
    }
    return idx;
  }
}

// Tolerant of whitespace: the relay writes these with JSON.stringify, but a
// hand-written or pretty-printed fixture should still be readable. `tab` is
// optional because a recording made before windows were written down has none.
const HEAD_RE = /^\{\s*"k"\s*:\s*([01])\s*,\s*"ts"\s*:\s*(\d+)\s*(?:,\s*"tab"\s*:\s*"([^"]*)")?/;

/**
 * `{"k":1,"ts":123,"tab":"abc"…` -> kind, time and window, from a line's first
 * bytes. Wide enough to reach past a millisecond stamp and a window id, so a
 * keyframe holding a whole document is still never parsed just to be indexed.
 */
function parseHead(buf: Buffer, pos: number): { keyframe: boolean; ts: number; tab?: string } | null {
  const m = HEAD_RE.exec(buf.subarray(pos, pos + 96).toString('latin1'));
  if (!m) return null;
  return { keyframe: m[1] === '1', ts: Number(m[2]), ...(m[3] ? { tab: m[3] } : {}) };
}

function keyframeAtOrBefore(keyframes: Keyframe[], ts: number): Keyframe | null {
  let lo = 0;
  let hi = keyframes.length - 1;
  let found: Keyframe | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const kf = keyframes[mid]!;
    if (kf.ts <= ts) {
      found = kf;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
