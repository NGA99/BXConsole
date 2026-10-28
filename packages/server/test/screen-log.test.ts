/**
 * ScreenLog: the recording the Screen panel rewinds through.
 *
 * What is pinned here is what playback cannot survive being wrong about —
 * the keyframe index, how a seek and a continue carve the file up, that
 * compaction leaves a file that still starts at a keyframe with honest
 * counters, and that all of it comes back from a plain scan after a restart.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCREEN_LOG_FILE, type ScreenRecord, type ScreenSnapshot } from '@bxconsole/protocol';
import { ScreenLog } from '../src/screen-log';

/** The seek/continue window in screen-log.ts; an idle gap wider than this is the interesting case. */
const SEGMENT_MS = 30_000;
const SESSION = 's';
const T0 = 1_000_000;

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

/** `pad` bytes of filler, to reach a retention budget without writing a million lines. */
function snapshot(ts: number, pad = 0): ScreenSnapshot {
  return {
    type: 'screen.snapshot',
    ts,
    url: `http://example.test/#${ts}`,
    viewport: { width: 100, height: 100 },
    scroll: { x: 0, y: 0 },
    focus: null,
    doc: [{ id: 1, t: 'el', tag: 'html', attrs: pad ? { 'data-pad': 'y'.repeat(pad) } : {}, children: [] }],
  };
}

function batch(ts: number, text: string): ScreenRecord {
  return { k: 0, ts, ops: [{ op: 'text', id: 1, text }] };
}

async function newLog(maxBytes?: number): Promise<{ log: ScreenLog; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-screenlog-'));
  dirs.push(dir);
  return { log: reopen(dir, maxBytes), dir };
}

/** A second ScreenLog over the same directory: what a relay restart does. */
function reopen(dir: string, maxBytes?: number): ScreenLog {
  return new ScreenLog(() => dir, maxBytes);
}

/** The file as the ground truth to check the in-memory index against. */
async function readRecords(dir: string): Promise<ScreenRecord[]> {
  const text = await fs.readFile(path.join(dir, SCREEN_LOG_FILE), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ScreenRecord);
}

describe('which window a segment came from', () => {
  /*
   * A run holds several windows and only one streams at a time, so the
   * recording is theirs in turn and scrubbing walks between them. The segment
   * has to say which one it landed on, or the viewer shows one window under a
   * tab strip pointing at another and says nothing about it.
   *
   * Both ways a keyframe reaches the index are pinned, because they are not
   * the same code: a live run appends, and a restart scans. The append path
   * was the one that forgot, which is the path a run being watched uses.
   */
  test('a live recording reports the window of the frame in view', async () => {
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, tab: 'tab-A', snapshot: snapshot(T0) });
    log.append(SESSION, { k: 1, ts: T0 + 5_000, tab: 'tab-C', snapshot: snapshot(T0 + 5_000) });

    assert.equal((await log.segment(SESSION, T0, 'seek')).tab, 'tab-A');
    assert.equal((await log.segment(SESSION, T0 + 5_000, 'seek')).tab, 'tab-C');
  });

  test('and so does one read back from disk after a restart', async () => {
    const { log, dir } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, tab: 'tab-A', snapshot: snapshot(T0) });
    log.append(SESSION, { k: 1, ts: T0 + 5_000, tab: 'tab-C', snapshot: snapshot(T0 + 5_000) });
    await log.segment(SESSION, T0, 'seek'); // flush

    const fresh = reopen(dir);
    assert.equal((await fresh.segment(SESSION, T0, 'seek')).tab, 'tab-A');
    assert.equal((await fresh.segment(SESSION, T0 + 5_000, 'seek')).tab, 'tab-C');
  });

  test('a recording made before windows were written down has none, and still replays', async () => {
    const { log, dir } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, snapshot: snapshot(T0) });
    log.append(SESSION, batch(T0 + 10, 'hello'));
    const live = await log.segment(SESSION, T0, 'seek');
    assert.equal(live.tab, undefined);
    assert.ok(live.snapshot, 'the frame still comes back');

    const fresh = reopen(dir);
    const read = await fresh.segment(SESSION, T0, 'seek');
    assert.equal(read.tab, undefined);
    assert.ok(read.snapshot);
  });

  test('a recording that spans a relay change does not pour the old part into every window', async () => {
    /*
     * An agent rejoins its session by the id it kept, so a run that was going
     * when the relay was replaced carries lines from before the change. Those
     * name no window. Letting them through for whichever window was asked for
     * replayed one window's work inside another — which is what this looked
     * like from the outside.
     */
    const { log } = await newLog();
    // before: no window on anything
    log.append(SESSION, { k: 1, ts: T0, snapshot: snapshot(T0) });
    log.append(SESSION, batch(T0 + 10, 'from before the change'));
    // after: both windows named
    log.append(SESSION, { k: 1, ts: T0 + 1_000, tab: 'tab-A', snapshot: snapshot(T0 + 1_000) });
    log.append(SESSION, { k: 0, ts: T0 + 1_010, tab: 'tab-A', ops: [{ op: 'text', id: 1, text: 'A did this' }] });
    log.append(SESSION, { k: 1, ts: T0 + 2_000, tab: 'tab-B', snapshot: snapshot(T0 + 2_000) });
    log.append(SESSION, { k: 0, ts: T0 + 2_010, tab: 'tab-B', ops: [{ op: 'text', id: 1, text: 'B did this' }] });

    const a = await log.segment(SESSION, T0 + 1_000, 'seek', 'tab-A');
    const texts = (seg: typeof a) => seg.batches.flatMap((b) => b.ops.map((o) => ('text' in o ? o.text : '')));
    assert.deepEqual(texts(a), ['A did this'], 'A replayed something that was not its own');

    const b = await log.segment(SESSION, T0 + 2_000, 'seek', 'tab-B');
    assert.deepEqual(texts(b), ['B did this']);

    // and the whole recording is still the whole recording
    const all = await log.segment(SESSION, T0, 'seek');
    assert.ok(texts(all).includes('from before the change'));
  });

  test('the window does not disturb the index the scan builds from the line', async () => {
    const { log, dir } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, tab: 'a-rather-long-window-id-0123456789', snapshot: snapshot(T0) });
    log.append(SESSION, batch(T0 + 10, 'x'));
    log.append(SESSION, { k: 1, ts: T0 + 1_000, tab: 'b', snapshot: snapshot(T0 + 1_000) });
    await log.segment(SESSION, T0, 'seek');

    // A long id pushes `tab` further along the line; ts and the batch count
    // are read from the same prefix and must survive that.
    const fresh = reopen(dir);
    const seg = await fresh.segment(SESSION, T0 + 1_000, 'seek');
    assert.equal(seg.tab, 'b');
    assert.deepEqual(seg.bounds, { start: T0, end: T0 + 1_000 });
    assert.equal(seg.changes, 1, 'the op batch is still counted');
  });
});

describe('ScreenLog', () => {
  test('bounds span the first and last record', async () => {
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, snapshot: snapshot(T0) });
    log.append(SESSION, batch(T0 + 100, 'a'));
    log.append(SESSION, batch(T0 + 900, 'b'));

    assert.deepEqual(await log.bounds(SESSION), { start: T0, end: T0 + 900 });
    log.forget(SESSION);
  });

  test('seek lands on the keyframe at or before the moment, with batches in order', async () => {
    const { log } = await newLog();
    for (let seg = 0; seg < 4; seg++) {
      const base = T0 + seg * 10_000;
      log.append(SESSION, { k: 1, ts: base, snapshot: snapshot(base) });
      for (let i = 0; i < 5; i++) log.append(SESSION, batch(base + i * 100 + 1, `${seg}:${i}`));
    }

    for (const at of [T0, T0 + 5_000, T0 + 10_001, T0 + 29_999]) {
      const seg = await log.segment(SESSION, at, 'seek');
      assert.ok(seg.snapshot, `seek at ${at} has no keyframe`);
      assert.ok(seg.snapshot.ts <= at, `keyframe ${seg.snapshot.ts} is after the moment ${at}`);
      const times = seg.batches.map((b) => b.ts);
      assert.deepEqual(times, [...times].sort((x, y) => x - y), 'batches are not time-ordered');
      assert.ok(times.every((ts) => ts >= seg.snapshot!.ts), 'a batch predates its own keyframe');
    }
    log.forget(SESSION);
  });

  test('continue repeats each batch of the boundary millisecond exactly once', async () => {
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, snapshot: snapshot(T0) });
    log.append(SESSION, batch(T0 + 100, 'a'));
    // two batches share the boundary millisecond: the caller holds them and drops them itself
    log.append(SESSION, batch(T0 + 200, 'b'));
    log.append(SESSION, batch(T0 + 200, 'c'));
    log.append(SESSION, batch(T0 + 300, 'd'));

    const cont = await log.segment(SESSION, T0 + 200, 'continue');
    assert.ok(!cont.snapshot, 'continue must not resend a keyframe');
    assert.deepEqual(
      cont.batches.map((b) => b.ts - T0),
      [200, 200, 300],
      'continue must start at the boundary millisecond and move on',
    );
    log.forget(SESSION);
  });

  test('continue crosses an idle gap wider than one window instead of answering empty', async () => {
    // The regression: an empty answer left the player asking from the same
    // moment forever, so an idle page never resumed.
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, snapshot: snapshot(T0) });
    log.append(SESSION, batch(T0 + 100, 'a'));
    log.append(SESSION, batch(T0 + 200, 'b'));
    const resumesAt = T0 + 200 + SEGMENT_MS * 10;
    log.append(SESSION, batch(resumesAt, 'c'));
    log.append(SESSION, batch(resumesAt + 100, 'd'));

    const cont = await log.segment(SESSION, T0 + 200, 'continue');
    assert.ok(
      cont.batches.some((b) => b.ts > T0 + 200),
      'continue returned nothing past the idle gap, so playback would stall',
    );
    assert.equal(cont.batches.find((b) => b.ts > T0 + 200)!.ts, resumesAt);
    log.forget(SESSION);
  });

  test('compaction leaves a shorter file that still starts at a keyframe, with honest counters', async () => {
    const BUDGET = 200 * 1024;
    const { log, dir } = await newLog(BUDGET);
    const SEGMENTS = 40;
    const PER_SEGMENT = 20;
    for (let seg = 0; seg < SEGMENTS; seg++) {
      const base = T0 + seg * 10_000;
      log.append(SESSION, { k: 1, ts: base, snapshot: snapshot(base, 2000) });
      for (let i = 0; i < PER_SEGMENT; i++) log.append(SESSION, batch(base + i * 100 + 1, `${seg}:${i}`.padEnd(200, 'x')));
    }

    // segment() flushes and settles the write chain, so compaction has run by now
    const bounds = (await log.segment(SESSION, T0, 'seek')).bounds!;
    const file = path.join(dir, SCREEN_LOG_FILE);
    const size = (await fs.stat(file)).size;
    assert.ok(size <= BUDGET, `file is ${size} bytes, over the ${BUDGET} budget`);

    const records = await readRecords(dir);
    assert.ok(records.length < SEGMENTS * (PER_SEGMENT + 1), 'nothing was dropped, so compaction never ran');
    assert.equal(records[0]!.k, 1, 'the file no longer starts at a keyframe, so the oldest moment cannot be restored');
    assert.equal(bounds.start, records[0]!.ts, 'bounds still claim the records compaction dropped');

    const fileBatches = records.filter((r) => r.k === 0).length;
    for (const at of [bounds.start, (bounds.start + bounds.end) / 2, bounds.end]) {
      const seg = await log.segment(SESSION, at, 'seek');
      assert.equal(seg.changes, fileBatches, `changes at ${at} does not match the file`);
      const before = records.filter((r) => r.k === 0 && r.ts < seg.snapshot!.ts).length;
      assert.equal(seg.from, before, `from at ${at} does not match the file`);
    }
    log.forget(SESSION);
  });

  /*
   * The budget belongs to the run, not to each window, and `data-screen` is
   * `record` by default — so a run that has spread streams several windows
   * into one file. A window that closed early sits entirely in the part
   * compaction throws away, and once it was gone the console had nothing to
   * show for that tab at all: the tab stayed in the strip and opening it gave
   * a blank Screen. What a closed window last looked like is the only thing
   * its tab has left.
   */
  test('a window whose segments compaction drops keeps its last frame', async () => {
    const BUDGET = 200 * 1024;
    const { log } = await newLog(BUDGET);
    const EARLY = 'tabearly';
    const LONG = 'tablong';

    // The window that closes early, with a recognisable last moment.
    log.append(SESSION, { k: 1, ts: T0, tab: EARLY, snapshot: snapshot(T0, 2000) });
    log.append(SESSION, { ...batch(T0 + 1, 'the last thing it showed'), tab: EARLY });

    // The one that stays open and pushes the file past its budget.
    for (let seg = 0; seg < 40; seg++) {
      const base = T0 + 10_000 + seg * 10_000;
      log.append(SESSION, { k: 1, ts: base, tab: LONG, snapshot: snapshot(base, 2000) });
      for (let i = 0; i < 20; i++) log.append(SESSION, { ...batch(base + i * 100 + 1, `${seg}:${i}`.padEnd(200, 'x')), tab: LONG });
    }

    // segment() flushes and settles the write chain, so compaction has run.
    await log.segment(SESSION, T0 + 10_000, 'seek', LONG);
    assert.equal(await log.bounds(SESSION, EARLY), null, 'the early window still has segments, so compaction never reached it');

    const kept = await log.lastFrame(SESSION, EARLY);
    assert.ok(kept, 'the early window lost its last frame, so its tab opens on a blank Screen');
    assert.equal(kept.snapshot.ts, T0);
    assert.deepEqual(
      kept.ops.map((o) => o.ops[0]),
      [{ op: 'text', id: 1, text: 'the last thing it showed' }],
      'the ops after the keyframe were not kept with it',
    );
    log.forget(SESSION);
  });

  test('a window still in the recording is not given a rescued frame it does not need', async () => {
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, tab: 'tabhere', snapshot: snapshot(T0) });
    await log.segment(SESSION, T0, 'seek', 'tabhere');
    assert.equal(await log.lastFrame(SESSION, 'tabhere'), null);
    log.forget(SESSION);
  });

  test('a window id that is not one refuses to name a file', async () => {
    // Window ids arrive from the page, and they name files on disk.
    const { log } = await newLog();
    assert.equal(await log.lastFrame(SESSION, '../../etc/passwd'), null);
    log.forget(SESSION);
  });

  test('a restart rebuilds the same bounds and keyframes by scanning the file', async () => {
    // Guards the `{"k":1,"ts":…}` prefix scan: a record shape that no longer
    // matches it would leave a restarted relay with no keyframes at all.
    const { log, dir } = await newLog();
    for (let seg = 0; seg < 4; seg++) {
      const base = T0 + seg * 10_000;
      log.append(SESSION, { k: 1, ts: base, snapshot: snapshot(base) });
      for (let i = 0; i < 5; i++) log.append(SESSION, batch(base + i * 100 + 1, `${seg}:${i}`));
    }
    const at = T0 + 25_000;
    const original = await log.segment(SESSION, at, 'seek');
    log.forget(SESSION);

    const restarted = reopen(dir);
    assert.deepEqual(await restarted.bounds(SESSION), original.bounds);
    const scanned = await restarted.segment(SESSION, at, 'seek');
    assert.equal(scanned.snapshot?.ts, original.snapshot?.ts, 'the restart found a different keyframe');
    assert.equal(scanned.from, original.from);
    assert.equal(scanned.changes, original.changes);
    assert.deepEqual(scanned.batches, original.batches);
    restarted.forget(SESSION);
  });
});

describe('a window that recorded nothing', () => {
  /*
   * Only one window of a run streams at a time, so a run can be recorded for
   * twenty minutes and a window of it still hold not one line — any window
   * nobody opened the Screen tab on is in exactly that state.
   *
   * Asking for such a window used to give the whole run back, because the
   * same branch also covered a recording made before windows were written
   * down, which names none at all and is one undifferentiated run. The two
   * read alike in the index and are opposite in meaning: selecting the empty
   * window replayed every other window's work under its name, and freezing
   * on it showed another window's page.
   */
  test('asking for it gives nothing, not the whole run', async () => {
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, tab: 'win-a', snapshot: snapshot(T0) });
    for (let i = 0; i < 4; i++) log.append(SESSION, { ...batch(T0 + 10 + i, `a${i}`), tab: 'win-a' });
    log.append(SESSION, { k: 1, ts: T0 + 1000, tab: 'win-b', snapshot: snapshot(T0 + 1000) });
    for (let i = 0; i < 3; i++) log.append(SESSION, { ...batch(T0 + 1010 + i, `b${i}`), tab: 'win-b' });

    const whole = await log.segment(SESSION, T0, 'seek');
    assert.equal(whole.changes, 7, 'the run itself holds both windows');

    // 'win-c' is in the session's tab list but never streamed.
    assert.equal(await log.bounds(SESSION, 'win-c'), null, 'an empty window claims the run as its extent');
    const seg = await log.segment(SESSION, T0, 'seek', 'win-c');
    assert.equal(seg.bounds, null, 'an empty window is handed the run to scrub');
    assert.equal(seg.snapshot, undefined, "an empty window is shown another window's page");
    assert.deepEqual(seg.batches, [], "an empty window replays another window's ops");
    assert.equal(seg.changes, 0, 'an empty window is credited with the run\'s changes');
    assert.equal(seg.done, true);
    log.forget(SESSION);
  });

  test('a recording that names no window at all is still one whole run', async () => {
    // The case the old branch was written for, which must keep working: these
    // are recordings from before `tab` existed, and narrowing them shows nothing.
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, snapshot: snapshot(T0) });
    for (let i = 0; i < 4; i++) log.append(SESSION, batch(T0 + 10 + i, `x${i}`));

    const seg = await log.segment(SESSION, T0, 'seek', 'win-whatever');
    assert.ok(seg.bounds, 'an older recording lost its extent');
    assert.equal(seg.snapshot?.ts, T0, 'an older recording lost its keyframe');
    assert.equal(seg.changes, 4);
    assert.equal(seg.tab, undefined);
    log.forget(SESSION);
  });

  test('a window that streamed is unaffected', async () => {
    const { log } = await newLog();
    log.append(SESSION, { k: 1, ts: T0, tab: 'win-a', snapshot: snapshot(T0) });
    for (let i = 0; i < 4; i++) log.append(SESSION, { ...batch(T0 + 10 + i, `a${i}`), tab: 'win-a' });
    log.append(SESSION, { k: 1, ts: T0 + 1000, tab: 'win-b', snapshot: snapshot(T0 + 1000) });
    for (let i = 0; i < 3; i++) log.append(SESSION, { ...batch(T0 + 1010 + i, `b${i}`), tab: 'win-b' });

    const a = await log.segment(SESSION, T0, 'seek', 'win-a');
    assert.equal(a.tab, 'win-a');
    assert.equal(a.changes, 4);
    assert.deepEqual(
      a.batches.flatMap((b) => b.ops.map((o) => (o.op === 'text' ? o.text : o.op))),
      ['a0', 'a1', 'a2', 'a3'],
      'window A replayed something other than its own ops',
    );
    log.forget(SESSION);
  });
});
