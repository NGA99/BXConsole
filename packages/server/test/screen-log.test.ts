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
