import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownTiming, type Timeline } from '../src/panels/network/timing';

const at = (start: number, end: number): Timeline & { end: number } => ({ start, end, phases: [] });

test('the duration is the difference between the two times on screen', () => {
  // The case that prompted this: truncated to whole milliseconds the ends are
  // 24 apart, while the unrounded difference rounds to 25.
  const { start, end, total } = shownTiming(at(1_000_042.0, 1_000_066.9));
  assert.equal(end - start, total, 'what is printed can be checked by subtracting');
  assert.equal(total, 25);
});

test('both ends land on the millisecond the clock can show', () => {
  const { start, end } = shownTiming(at(10.4, 20.6));
  assert.equal(start, 10);
  assert.equal(end, 21);
});

test('a request that took no measurable time reads as zero, not as a fraction', () => {
  assert.equal(shownTiming(at(5.2, 5.4)).total, 0);
});

test('it never reports a negative duration for ends in order', () => {
  for (const [s, e] of [[0, 0], [1.9, 2.1], [99.5, 99.5], [12.49, 12.5]] as const) {
    assert.ok(shownTiming(at(s, e)).total >= 0, `${s} → ${e}`);
  }
});
