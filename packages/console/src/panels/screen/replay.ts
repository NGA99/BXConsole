/**
 * Playback of a session's recorded screen: the clock side of DOM time travel.
 *
 * The relay serves a segment at a time — a keyframe plus the op batches after
 * it (see server/src/screen-log.ts) — and this walks the playhead through
 * them, asking for the next segment before it runs out. The mirror itself is
 * the panel's (`loadSnapshot` / `applyOps`), so replay and live share one
 * DomMirror and everything built on it (Elements, highlights, rectOf).
 *
 * Ops are not invertible, so going backwards means rebuilding: from the
 * keyframe we already hold when possible, otherwise by seeking again.
 */
import type { ScreenOp, ScreenSegment, ScreenSnapshot } from '@bxconsole/protocol';
import { requestScreenSegment } from '../../transport/client';

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * Nothing happened for this long: jump the playhead instead of waiting it out.
 * Measured on real recordings, batches during actual interaction land about
 * 80 ms apart, while an idle page with a clock or a poll ticks once a second —
 * so 450 ms skips the idle second without touching the rhythm of real use.
 */
export const IDLE_GAP_MS = 450;
/** Ask for the next segment once the playhead is this close to the last batch we hold. */
const PREFETCH_MS = 5000;
/** Applied batches kept for stepping back; beyond this the oldest are dropped. */
const KEEP_APPLIED = 600;
const TRIM_AT = 4000;

interface Batch {
  ts: number;
  ops: ScreenOp[];
}

export interface ReplayStatus {
  bounds: { start: number; end: number } | null;
  /** the stretch the last jump skipped; `seq` so the same length shows twice */
  skipped?: { ms: number; seq: number };
  /** where playback stands */
  ts: number;
  playing: boolean;
  speed: Speed;
  loading: boolean;
  /** the recording has been played to its end */
  atEnd: boolean;
  /** url of the keyframe in view, as the page's address at that moment */
  url: string;
  /** position in the recording, counted in batches of DOM changes */
  step: number;
  /** batches in the whole recording, known from the first answer the relay gives */
  total: number;
}

/** The frame clock playback runs on; the browser's, unless a test drives it by hand. */
interface Frames {
  now(): number;
  request(run: () => void): number;
  cancel(handle: number): void;
}

const browserFrames: Frames = {
  now: () => performance.now(),
  request: (run) => requestAnimationFrame(run),
  cancel: (handle) => cancelAnimationFrame(handle),
};

interface Hooks {
  sessionId: string;
  loadSnapshot(snapshot: ScreenSnapshot): void;
  applyOps(ops: ScreenOp[]): void;
  onStatus(status: ReplayStatus): void;
  /** where segments come from; the relay, unless a test serves them */
  fetchSegment?(sessionId: string, ts: number, mode: 'seek' | 'continue'): Promise<ScreenSegment | null>;
  frames?: Frames;
}

export class ScreenReplayer {
  private readonly fetchSegment: NonNullable<Hooks['fetchSegment']>;
  private readonly frames: Frames;
  private snapshot: ScreenSnapshot | null = null;
  /** batches from `snapshot` onward, time-ordered */
  private batches: Batch[] = [];
  /** batches[0 .. cursor-1] have been applied to the mirror */
  private cursor = 0;
  /** the keyframe we hold can still rebuild the current moment (nothing applied was dropped) */
  private baseValid = false;
  private hasAllToEnd = false;
  private loading = false;
  private skipSeq = 0;
  /** applied batches dropped by trim(), so the counters do not jump backwards */
  private trimmed = 0;
  /** batches recorded before the segment in hand, so the position is the recording's, not the window's */
  private base = 0;
  private changes = 0;
  private raf: number | null = null;
  private lastFrameAt = 0;
  private disposed = false;

  private status: ReplayStatus = {
    bounds: null,
    ts: 0,
    playing: false,
    speed: 1,
    loading: false,
    atEnd: false,
    url: '',
    step: 0,
    total: 0,
  };

  constructor(private readonly hooks: Hooks) {
    this.fetchSegment = hooks.fetchSegment ?? requestScreenSegment;
    this.frames = hooks.frames ?? browserFrames;
  }

  getStatus(): ReplayStatus {
    return this.status;
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
  }

  /**
   * Which request the player is waiting for.
   *
   * Dragging the scrubber fires a seek per step and the answers come back in
   * any order, so without this an older segment can land last and leave the
   * mirror at a moment the clock and the slider do not report. A reply whose
   * token is no longer the current one is dropped.
   */
  private request = 0;

  // ------------------------------------------------------------------ seeking

  /**
   * Open the recording at its beginning, which is where a player starts.
   *
   * Asking for moment 0 is enough: no keyframe sits at or before it, so the
   * relay falls back to the first one and answers with the opening segment,
   * the full bounds and the total change count — in one round trip.
   */
  async rewind(): Promise<void> {
    await this.seek(0);
  }

  /** Show the recording as it was at `ts` (the end of the recording when omitted). */
  async seek(ts?: number): Promise<void> {
    // Any seek supersedes the one before it, including a local rebuild: a
    // reply still in flight must not drop its older moment on top of this one.
    const token = ++this.request;
    // Rebuild locally when the keyframe in hand already covers the moment.
    if (ts !== undefined && this.baseValid && this.snapshot && ts >= this.snapshot.ts && ts <= this.loadedUntil()) {
      this.rebuildTo(ts);
      return;
    }
    this.setStatus({ loading: true });
    const segment = await this.fetchSegment(this.hooks.sessionId, ts ?? Date.now(), 'seek');
    if (this.disposed || token !== this.request) return; // a later seek won
    if (!segment || !segment.snapshot) {
      this.setStatus({ loading: false, bounds: segment?.bounds ?? null });
      return;
    }
    this.snapshot = segment.snapshot;
    this.batches = segment.batches;
    this.cursor = 0;
    this.trimmed = 0;
    this.base = segment.from;
    this.changes = segment.changes;
    this.baseValid = true;
    this.hasAllToEnd = segment.done;
    this.hooks.loadSnapshot(segment.snapshot);
    const target = Math.max(ts ?? segment.bounds?.end ?? segment.snapshot.ts, segment.snapshot.ts);
    this.setStatus({ loading: false, bounds: segment.bounds, url: segment.snapshot.url, atEnd: false });
    this.applyUpTo(target);
    this.setStatus({ ts: target });
  }

  /** Re-apply from the keyframe we hold: the only way back, since ops do not undo. */
  private rebuildTo(ts: number): void {
    if (!this.snapshot) return;
    this.hooks.loadSnapshot(this.snapshot);
    this.cursor = 0;
    this.setStatus({ url: this.snapshot.url, atEnd: false });
    this.applyUpTo(ts);
    this.setStatus({ ts });
  }

  /** One batch forward / back, for picking apart a single mutation. */
  stepForward(): void {
    this.pause();
    const next = this.batches[this.cursor];
    if (!next) {
      if (!this.hasAllToEnd) void this.loadMore();
      return;
    }
    this.hooks.applyOps(next.ops);
    this.cursor++;
    this.setStatus({ ts: next.ts });
  }

  stepBack(): void {
    this.pause();
    if (this.cursor <= 0) return;
    const target = this.batches[this.cursor - 1]!;
    if (this.baseValid && this.snapshot) {
      // Rebuild to just before that batch.
      const prev = this.batches[this.cursor - 2];
      this.rebuildTo(prev ? prev.ts : this.snapshot.ts);
    } else {
      void this.seek(target.ts - 1);
    }
  }

  // ---------------------------------------------------------------- playback

  play(): void {
    if (this.status.playing) return;
    /*
     * Standing at the end, start over — like a media player.
     *
     * Keyed on the position, not only on the `atEnd` flag: entering replay
     * parks the playhead at the last frame with the flag still clear, so the
     * first press used to run one frame, discover there was nothing left, set
     * the flag and stop. It took a second press to play anything.
     */
    const { bounds, ts, atEnd } = this.status;
    if (bounds && (atEnd || ts >= bounds.end)) {
      void this.seek(bounds.start).then(() => this.start());
      return;
    }
    this.start();
  }

  private start(): void {
    this.setStatus({ playing: true, atEnd: false });
    this.lastFrameAt = this.frames.now();
    this.schedule();
  }

  pause(): void {
    if (this.raf !== null) this.frames.cancel(this.raf);
    this.raf = null;
    if (this.status.playing) this.setStatus({ playing: false });
  }

  setSpeed(speed: Speed): void {
    this.setStatus({ speed });
  }

  private schedule(): void {
    this.raf = this.frames.request(() => {
      this.raf = null;
      this.frame();
    });
  }

  private frame(): void {
    if (this.disposed || !this.status.playing) return;
    const now = this.frames.now();
    const elapsed = Math.min(now - this.lastFrameAt, 1000) * this.status.speed;
    this.lastFrameAt = now;

    const pending = this.batches[this.cursor];
    let ts = this.status.ts + elapsed;

    // Idle stretches are skipped: a replay should not make you sit through a
    // minute in which the page did nothing. What counts as the next thing to
    // wait for is the next batch of mutations — or, once there are none left
    // and the recording is fully loaded, its end. Without that second case a
    // recording that stops mutating long before it stops (an idle page whose
    // only later records are keyframes) would play out the remaining minutes
    // in real time with a frozen picture.
    const nextTs = pending ? pending.ts : this.hasAllToEnd ? this.status.bounds?.end : undefined;
    let jumped = 0;
    if (nextTs !== undefined && nextTs - this.status.ts > IDLE_GAP_MS) {
      jumped = nextTs - this.status.ts;
      ts = nextTs;
    }

    const until = this.loadedUntil();
    if (ts > until && !this.hasAllToEnd) {
      // Hold at the edge of what we have rather than skipping over unloaded ops.
      ts = until;
      void this.loadMore();
    }
    if (ts !== nextTs) jumped = 0; // held back above: the jump did not happen
    // Say how much was skipped, so a picture that suddenly moves on is explained.
    const skip = jumped ? { skipped: { ms: jumped, seq: ++this.skipSeq } } : {};
    this.applyUpTo(ts);
    const end = this.status.bounds?.end ?? ts;
    if (this.hasAllToEnd && ts >= end && this.cursor >= this.batches.length) {
      this.setStatus({ ts: end, atEnd: true, ...skip });
      this.pause();
      return;
    }
    this.setStatus({ ts, ...skip });
    if (ts >= until - PREFETCH_MS && !this.hasAllToEnd) void this.loadMore();
    this.schedule();
  }

  // --------------------------------------------------------------- internals

  private applyUpTo(ts: number): void {
    let applied = 0;
    while (this.cursor < this.batches.length && this.batches[this.cursor]!.ts <= ts) {
      this.hooks.applyOps(this.batches[this.cursor]!.ops);
      this.cursor++;
      applied++;
    }
    if (applied) {
      this.trim();
      this.setStatus({});
    }
  }

  /** Keep the applied history bounded; dropping it costs the local rebuild. */
  private trim(): void {
    if (this.cursor <= TRIM_AT) return;
    const drop = this.cursor - KEEP_APPLIED;
    this.batches = this.batches.slice(drop);
    this.cursor -= drop;
    this.trimmed += drop;
    this.baseValid = false;
  }

  private loadedUntil(): number {
    const last = this.batches[this.batches.length - 1];
    return last ? last.ts : (this.snapshot?.ts ?? 0);
  }

  private async loadMore(): Promise<void> {
    if (this.loading || this.hasAllToEnd) return;
    this.loading = true;
    this.setStatus({ loading: true });
    const token = this.request;
    const edge = this.loadedUntil();
    const segment = await this.fetchSegment(this.hooks.sessionId, edge, 'continue');
    this.loading = false;
    // A seek landed while this was in flight: these batches belong to the
    // segment we just replaced, and appending them would apply ops out of order.
    if (this.disposed || token !== this.request) return;
    if (!segment) return this.setStatus({ loading: false });
    // The answer starts at `edge` inclusive (batches can share a millisecond),
    // so drop as many of its leading batches at that moment as we already hold.
    let held = 0;
    for (let i = this.batches.length - 1; i >= 0 && this.batches[i]!.ts === edge; i--) held++;
    let skip = 0;
    while (skip < held && segment.batches[skip]?.ts === edge) skip++;
    this.batches.push(...segment.batches.slice(skip));
    this.hasAllToEnd = segment.done;
    this.changes = segment.changes;
    this.setStatus({ loading: false, bounds: segment.bounds ?? this.status.bounds });
  }

  private setStatus(patch: Partial<ReplayStatus>): void {
    // The counters follow the batch list, so they are recomputed on every
    // update rather than remembered in a dozen places.
    this.status = {
      ...this.status,
      step: this.base + this.trimmed + this.cursor,
      total: Math.max(this.changes, this.base + this.trimmed + this.cursor),
      ...patch,
    };
    if (!this.disposed) this.hooks.onStatus(this.status);
  }
}
