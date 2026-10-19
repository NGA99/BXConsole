/**
 * ScreenReplayer: the clock side of DOM time travel.
 *
 * The mirror and the transport are the player's two seams (`hooks`), so what
 * is pinned here is only its time arithmetic — where the playhead sits in the
 * whole recording, that a step is one batch in either direction, that idle
 * stretches are jumped rather than waited out, and that a segment overtaken
 * by a newer seek is thrown away.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScreenOp, ScreenSegment, ScreenSnapshot } from '@bxconsole/protocol';
import { IDLE_GAP_MS, ScreenReplayer, type ReplayStatus } from '../src/panels/screen/replay';

type Fetch = (sessionId: string, ts: number, mode: 'seek' | 'continue') => Promise<ScreenSegment | null>;

const T = 1_000_000;

function snapshot(ts: number): ScreenSnapshot {
  return {
    type: 'screen.snapshot',
    ts,
    url: `http://example.test/#${ts}`,
    viewport: { width: 100, height: 100 },
    scroll: { x: 0, y: 0 },
    focus: null,
    doc: [{ id: 1, t: 'el', tag: 'html', attrs: {}, children: [] }],
  };
}

/** The seek/continue window the real relay answers with (screen-log.ts). */
const SEGMENT_MS = 30_000;

/**
 * A relay serving one fixed recording: keyframes at `keyframeTimes`, op
 * batches at `batchTimes`. It answers one window at a time, like the real one,
 * so a seek past what is loaded really has to fetch another segment instead of
 * rebuilding from the keyframe already in hand.
 */
function relayFor(keyframeTimes: number[], batchTimes: number[]): Fetch {
  const all = batchTimes.map((ts) => ({ ts, ops: [{ op: 'text', id: 1, text: `t${ts}` }] as ScreenOp[] }));
  const bounds = { start: Math.min(...keyframeTimes, ...batchTimes), end: Math.max(...keyframeTimes, ...batchTimes) };
  /** batches from `first` on, up to the window — never empty, as the relay never answers with nothing */
  const take = (first: number, until: number) => {
    const batches: typeof all = [];
    for (let i = first; i < all.length; i++) {
      if (all[i]!.ts > until && batches.length > 0) return { batches, done: false };
      batches.push(all[i]!);
    }
    return { batches, done: true };
  };
  return (_sessionId, ts, mode) => {
    if (mode === 'continue') {
      const first = all.findIndex((b) => b.ts >= ts);
      const { batches, done } = first === -1 ? { batches: [], done: true } : take(first, ts + SEGMENT_MS);
      return Promise.resolve({ bounds, batches, done, changes: all.length, from: 0 });
    }
    const kfTs = [...keyframeTimes].reverse().find((k) => k <= ts) ?? keyframeTimes[0]!;
    const from = all.filter((b) => b.ts < kfTs).length;
    const { batches, done } = take(from, Math.max(ts, kfTs) + SEGMENT_MS);
    return Promise.resolve({ bounds, snapshot: snapshot(kfTs), batches, done, changes: all.length, from });
  };
}

/** A frame clock the test advances by hand, in place of requestAnimationFrame. */
function manualFrames() {
  let now = 0;
  let next: (() => void) | null = null;
  return {
    frames: {
      now: () => now,
      request(run: () => void) {
        next = run;
        return 1;
      },
      cancel() {
        next = null;
      },
    },
    /** let `ms` of wall clock pass and run the frame waiting on it */
    tick(ms: number) {
      now += ms;
      const run = next;
      next = null;
      run?.();
    },
  };
}

function makeReplayer(fetchSegment: Fetch, frames?: ReturnType<typeof manualFrames>['frames']) {
  /** keyframe times handed to the mirror, in order */
  const loaded: number[] = [];
  /** op batches applied to the mirror, in order */
  const applied: ScreenOp[][] = [];
  const replayer = new ScreenReplayer({
    sessionId: 'session',
    loadSnapshot: (snap) => void loaded.push(snap.ts),
    applyOps: (ops) => void applied.push(ops),
    onStatus: () => {},
    fetchSegment,
    frames,
  });
  const status = (): ReplayStatus => replayer.getStatus();
  return { replayer, loaded, applied, status };
}

describe('ScreenReplayer', () => {
  // two segments: batches 0-2 under the first keyframe, 3-5 under the second
  const KEYFRAMES = [T, T + 60_000];
  const BATCHES = [T + 100, T + 200, T + 300, T + 60_100, T + 60_200, T + 60_300];

  test('the player opens at the start of the recording, not its end', async () => {
    // What the Replay button does. Opening at the end showed "0:46 / 0:46"
    // with nothing left to play.
    const { replayer, status } = makeReplayer(relayFor(KEYFRAMES, BATCHES));
    await replayer.rewind();
    assert.equal(status().ts, status().bounds!.start);
    assert.equal(status().atEnd, false);
  });

  test('one press of play starts it moving', async () => {
    const f = manualFrames();
    const { replayer, status } = makeReplayer(relayFor(KEYFRAMES, BATCHES), f.frames);
    await replayer.rewind();
    const from = status().ts;
    replayer.play();
    f.tick(200);
    assert.equal(status().playing, true);
    assert.ok(status().ts > from, `the playhead moved on the first press (${status().ts} vs ${from})`);
  });

  test('pressing play while parked at the end starts over, on the first press', async () => {
    // Entering replay used to park the playhead at the last frame with the
    // atEnd flag still clear, so the first press ran one frame, discovered
    // there was nothing left, and stopped.
    const f = manualFrames();
    const { replayer, status } = makeReplayer(relayFor(KEYFRAMES, BATCHES), f.frames);
    await replayer.seek();
    assert.equal(status().ts, status().bounds!.end, 'a seek with no moment lands at the end');
    replayer.play();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    f.tick(200);
    assert.equal(status().playing, true, 'still playing after the first press');
    assert.ok(status().ts < status().bounds!.end, 'and it went back to the beginning to do it');
  });

  test('a seek reports its position in the whole recording, not in the segment it loaded', async () => {
    const { replayer, status } = makeReplayer(relayFor(KEYFRAMES, BATCHES));

    await replayer.seek(T + 100);
    assert.equal(status().step, 1, 'the first segment starts at batch 0');
    assert.equal(status().total, BATCHES.length);

    // the second segment is served with from = 3, so its own batches count from there
    await replayer.seek(T + 60_200);
    assert.equal(status().step, 5, 'the position fell back to the segment-local count');
    assert.equal(status().total, BATCHES.length);
    assert.equal(status().ts, T + 60_200);
  });

  test('stepForward and stepBack move exactly one batch', async () => {
    const { replayer, loaded, applied, status } = makeReplayer(relayFor(KEYFRAMES, BATCHES));
    await replayer.seek(T + 60_200);
    const from = status().step;

    replayer.stepForward();
    assert.equal(status().step, from + 1);
    assert.equal(status().ts, T + 60_300);

    // back is a rebuild from the keyframe in hand: ops do not undo
    const reloads = loaded.length;
    applied.length = 0;
    replayer.stepBack();
    assert.equal(status().step, from, 'stepBack did not land one batch back');
    assert.equal(status().ts, T + 60_200);
    assert.equal(loaded.length, reloads + 1, 'stepBack must rebuild from the keyframe');
    assert.deepEqual(
      applied.map((ops) => (ops[0] as { text: string }).text),
      [`t${T + 60_100}`, `t${T + 60_200}`],
      'the rebuild replayed the wrong batches',
    );
  });

  test('playback jumps an idle stretch instead of waiting it out', async () => {
    const clock = manualFrames();
    const idle = T + 50 + IDLE_GAP_MS * 10;
    const { replayer, status } = makeReplayer(relayFor([T], [T + 50, idle]), clock.frames);
    await replayer.seek(T);

    replayer.play();
    clock.tick(100); // past the first batch, which is close enough to play through
    assert.equal(status().ts, T + 100);
    assert.ok(status().skipped === undefined, 'a gap under the threshold was skipped');

    clock.tick(16); // now the only batch left is far away
    assert.equal(status().ts, idle, 'the playhead did not jump to the next batch');
    assert.ok((status().skipped?.ms ?? 0) > IDLE_GAP_MS, 'the jump was not reported');
    replayer.dispose();
  });

  test('playback jumps to the end once no batches are left', async () => {
    // The recording outlasts its last mutation (later records are keyframes
    // only), so sitting out the remainder would freeze the picture for minutes.
    const clock = manualFrames();
    const end = T + 20_000;
    const { replayer, status } = makeReplayer(relayFor([T, end], [T + 50]), clock.frames);
    await replayer.seek(T);
    assert.equal(status().bounds?.end, end);

    replayer.play();
    clock.tick(100); // applies the last batch
    clock.tick(16);
    assert.equal(status().ts, end, 'the playhead did not reach the end of the recording');
    assert.ok(status().atEnd);
    assert.equal(status().playing, false, 'playback kept running past the end');
  });

  test('a segment that arrives after a newer seek is dropped', async () => {
    const relay = relayFor(KEYFRAMES, BATCHES);
    const queue: Array<() => void> = [];
    const deferred: Fetch = (sessionId, ts, mode) =>
      new Promise((resolve) => queue.push(() => void relay(sessionId, ts, mode).then(resolve)));
    const { replayer, loaded, status } = makeReplayer(deferred);

    void replayer.seek(T + 100); // first segment, slow
    void replayer.seek(T + 60_200); // second segment, supersedes it
    assert.equal(queue.length, 2);

    queue[1]!(); // the newer answer lands first
    await settle();
    queue[0]!(); // …and the older one afterwards
    await settle();

    assert.deepEqual(loaded, [T + 60_000], 'the stale segment was applied on top of the current one');
    assert.equal(status().ts, T + 60_200);
    assert.equal(status().step, 5);
  });
});

/** let the awaited continuations inside the player run */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The recorded cursor.
 *
 * Live, the pointer is drawn from a stream of events; in a recording it has to
 * be reconstructed from samples, and the one rule that matters is that it is
 * never shown somewhere it has not reached yet. A cursor that runs ahead of
 * the DOM it is supposed to be acting on tells the reader the wrong story
 * about what the person was doing.
 */
function relayWithPointer(points: Array<{ ts: number; x: number; y: number; pressed?: boolean }>): Fetch {
  const bounds = { start: T, end: T + 60_000 };
  const snap = snapshot(T);
  return (_sessionId, ts, mode) =>
    Promise.resolve({
      bounds,
      ...(mode === 'seek' ? { snapshot: snap } : {}),
      batches: [],
      done: true,
      changes: 0,
      from: 0,
      pointer: points
        .filter((p) => (mode === 'seek' ? true : p.ts >= ts))
        .map((p) => ({ ts: p.ts, x: p.x, y: p.y, pressed: p.pressed ?? false })),
    });
}

describe('the recorded cursor', () => {
  const trail = [
    { ts: T + 1000, x: 10, y: 10 },
    { ts: T + 2000, x: 20, y: 20 },
    { ts: T + 3000, x: 30, y: 30, pressed: true },
    { ts: T + 4000, x: 40, y: 40 },
  ];

  test('a seek shows where the pointer was at that moment, not where it ends up', async () => {
    const { replayer, status } = makeReplayer(relayWithPointer(trail));
    await replayer.seek(T + 2500);
    assert.deepEqual({ x: status().pointer?.x, y: status().pointer?.y }, { x: 20, y: 20 });
  });

  test('it never runs ahead of the playhead', async () => {
    const { replayer, status } = makeReplayer(relayWithPointer(trail));
    await replayer.seek(T + 1500);
    assert.equal(status().pointer?.x, 10, 'the sample at 2000 has not happened yet');
  });

  test('before the first sample there is nothing to draw', async () => {
    const { replayer, status } = makeReplayer(relayWithPointer(trail));
    await replayer.seek(T + 500);
    assert.equal(status().pointer, null);
  });

  test('a press is reported as pressed, and only while it is', async () => {
    const { replayer, status } = makeReplayer(relayWithPointer(trail));
    await replayer.seek(T + 3000);
    assert.equal(status().pointer?.pressed, true);
    await replayer.seek(T + 4000);
    assert.equal(status().pointer?.pressed, false);
  });

  test('seeking backwards finds where it used to be', async () => {
    // The trail is kept whole rather than consumed, so going back is not a
    // rebuild — it is a lookup.
    const { replayer, status } = makeReplayer(relayWithPointer(trail));
    await replayer.seek(T + 4000);
    assert.equal(status().pointer?.x, 40);
    await replayer.seek(T + 1000);
    assert.equal(status().pointer?.x, 10);
  });

  test('a recording with no cursor samples replays without one', async () => {
    const { replayer, status } = makeReplayer(relayFor([T], [T + 1000]));
    await replayer.seek(T + 1000);
    assert.equal(status().pointer, null);
  });

  test('samples land on the exact millisecond they were recorded at', async () => {
    const { replayer, status } = makeReplayer(relayWithPointer(trail));
    await replayer.seek(T + 2000);
    assert.equal(status().pointer?.x, 20, 'at or before, so the boundary sample counts');
  });
});
