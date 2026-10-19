/**
 * Disk persistence under sessions/session-{sessionId}/.
 * Layout is defined in @bxconsole/protocol `paths.ts`.
 *
 * Append-only ndjson per area so a crashed relay loses at most one line, and
 * so the console can tail a file by area (console vs network) independently.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  SCREEN_FRAME_FILE,
  SESSION_FILES,
  fileForEventType,
  sessionDirName,
  type SequencedEvent,
  type SessionMeta,
} from '@bxconsole/protocol';
import { ScreenLog } from './screen-log';

const HISTORY_CHUNK = 500;

export class SessionStore {
  /** per-session write queue so appends land on disk in event order */
  private readonly chains = new Map<string, Promise<void>>();
  /** the Screen recording, which is a time-indexed log rather than seq'd events */
  readonly screen = new ScreenLog((sessionId) => this.dirFor(sessionId));

  constructor(private readonly rootDir: string) {}

  dirFor(sessionId: string): string {
    return path.join(this.rootDir, sessionDirName(sessionId));
  }

  async writeMeta(meta: SessionMeta): Promise<void> {
    const dir = this.dirFor(meta.sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, SESSION_FILES.meta), JSON.stringify(meta, null, 2));
  }

  /**
   * Append one event to its file, in call order.
   *
   * The event may be given as a promise, for a caller that has to do work
   * before it knows what to write — moving a large body into the blob store,
   * say. Resolving it inside the chain rather than before it is what keeps
   * the file in seq order: awaiting first would let a cheap event overtake an
   * expensive one and leave the recording out of order.
   */
  appendEvent(sessionId: string, item: SequencedEvent | Promise<SequencedEvent>): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const resolved = await item;
        const file = fileForEventType(resolved.event.type);
        if (!file) return;
        await fs.appendFile(path.join(this.dirFor(sessionId), SESSION_FILES[file]), JSON.stringify(resolved) + '\n');
      })
      .catch((err: unknown) => console.warn('[bxconsole] append failed', err));
    this.chains.set(sessionId, next);
    return next;
  }

  /** Every session on disk with the highest seq seen, for registry warm-up. */
  async listSessions(): Promise<Array<{ meta: SessionMeta; lastSeq: number }>> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const out: Array<{ meta: SessionMeta; lastSeq: number }> = [];
    for (const name of await fs.readdir(this.rootDir)) {
      if (!name.startsWith('session-')) continue;
      try {
        const raw = await fs.readFile(path.join(this.rootDir, name, SESSION_FILES.meta), 'utf8');
        const meta = JSON.parse(raw) as SessionMeta;
        out.push({ meta, lastSeq: await this.lastSeq(meta.sessionId) });
      } catch {
        // half-written dir; skip
      }
    }
    return out;
  }

  /**
   * All persisted events, merged across files in seq order, in chunks.
   *
   * Each file is already in seq order because it is only ever appended to, so
   * they are merged a line at a time rather than read into one array and
   * sorted: a long run's console log can be hundreds of megabytes, and one
   * subscribe used to allocate the whole of it.
   */
  async *readHistory(sessionId: string): AsyncGenerator<SequencedEvent[]> {
    const streams = (['console', 'network', 'page', 'history'] as const).map((file) =>
      this.readNdjson(path.join(this.dirFor(sessionId), SESSION_FILES[file]))[Symbol.asyncIterator](),
    );
    // One line held per file: the next candidate from each.
    const heads: Array<SequencedEvent | null> = await Promise.all(
      streams.map(async (it) => {
        const first = await it.next();
        return first.done ? null : first.value;
      }),
    );

    // A file is normally in seq order, but not always: two relays writing the
    // same directory, or a crash mid-append, can leave a local inversion. The
    // merge therefore keeps a window of a few chunks, sorts it, and releases
    // the oldest — enough to repair nearby disorder without holding the run.
    const WINDOW = HISTORY_CHUNK * 4;
    let buf: SequencedEvent[] = [];
    for (;;) {
      let pick = -1;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (!h) continue;
        if (pick < 0 || h.seq < heads[pick]!.seq) pick = i;
      }
      if (pick < 0) break;

      buf.push(heads[pick]!);
      const next = await streams[pick]!.next();
      heads[pick] = next.done ? null : next.value;

      if (buf.length >= WINDOW) {
        buf.sort((a, b) => a.seq - b.seq);
        yield buf.slice(0, HISTORY_CHUNK);
        buf = buf.slice(HISTORY_CHUNK);
      }
    }
    buf.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < buf.length; i += HISTORY_CHUNK) yield buf.slice(i, i + HISTORY_CHUNK);
  }

  /**
   * The single last frame written by earlier versions. Sessions recorded since
   * then have screen.ndjson instead, which the relay prefers.
   */
  async readLegacyScreenFrame<T>(sessionId: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dirFor(sessionId), SCREEN_FRAME_FILE), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /**
   * Claim the sessions directory for this process.
   *
   * Two relays appending the same files interleave their writes and leave the
   * recordings out of seq order, which no reader can fully repair. A stale
   * lock from a crashed run is taken over; a live one is refused.
   */
  async lock(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const file = path.join(this.rootDir, '.relay-lock');
    try {
      const held = Number(await fs.readFile(file, 'utf8'));
      if (held && held !== process.pid && isRunning(held)) {
        throw new Error(`another relay (pid ${held}) is already using ${this.rootDir}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('another relay')) throw err;
      // no lock file, or an unreadable one: ours now
    }
    await fs.writeFile(file, String(process.pid));
    const release = () => {
      try {
        if (Number(fsSync.readFileSync(file, 'utf8')) === process.pid) fsSync.unlinkSync(file);
      } catch {
        /* already gone */
      }
    };
    process.on('exit', release);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        release();
        process.exit(0);
      });
    }
  }

  async remove(sessionId: string): Promise<void> {
    this.screen.forget(sessionId);
    await fs.rm(this.dirFor(sessionId), { recursive: true, force: true });
  }

  private async lastSeq(sessionId: string): Promise<number> {
    let max = 0;
    for (const file of ['console', 'network', 'page', 'history'] as const) {
      for await (const item of this.readNdjson(path.join(this.dirFor(sessionId), SESSION_FILES[file]))) {
        if (item.seq > max) max = item.seq;
      }
    }
    return max;
  }

  private async *readNdjson(file: string): AsyncGenerator<SequencedEvent> {
    try {
      await fs.access(file);
    } catch {
      return;
    }
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as SequencedEvent;
      } catch {
        // torn last line after a crash
      }
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
