/**
 * Axis ticks. Two panels drew the same axis from two copies of this, and the
 * History panel a third that only looked like the others — it snaps to
 * durations people name, because 1-2-5 offers 20 and 50 seconds where a
 * reader wants 30 seconds and a minute.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { niceStep, niceTimeStep } from '../src/devtools-ui/scale';

describe('niceStep', () => {
  test('lands on 1, 2 or 5 times a power of ten', () => {
    for (const raw of [1, 3, 7, 12, 37, 88, 140, 999, 1234, 48_000]) {
      const s = niceStep(raw);
      const pow = 10 ** Math.floor(Math.log10(s));
      assert.ok([1, 2, 5, 10].includes(Math.round(s / pow)), `${raw} gave ${s}`);
    }
  });

  test('never returns a step of zero, whatever it is handed', () => {
    for (const raw of [0, -1, 0.0001, Number.MIN_VALUE]) assert.ok(niceStep(raw) > 0, `${raw}`);
  });

  test('rises with the span', () => {
    let last = 0;
    for (const raw of [1, 10, 100, 1000, 10_000]) {
      const s = niceStep(raw);
      assert.ok(s >= last, `${raw} gave ${s} after ${last}`);
      last = s;
    }
  });
});

describe('niceTimeStep', () => {
  test('offers durations a person names', () => {
    assert.equal(niceTimeStep(1), 10);
    assert.equal(niceTimeStep(400), 500);
    assert.equal(niceTimeStep(25_000), 30_000, 'half a minute, not 50 seconds');
    assert.equal(niceTimeStep(70_000), 120_000, 'two minutes, not 100 seconds');
  });

  test('an exact step is taken as it is, not rounded up to the next', () => {
    for (const s of [10, 500, 1000, 30_000, 3_600_000]) assert.equal(niceTimeStep(s), s);
  });

  test('beyond the longest step it stops rather than running away', () => {
    assert.equal(niceTimeStep(10 ** 12), 3_600_000);
  });

  test('never returns zero', () => {
    for (const raw of [0, -5]) assert.ok(niceTimeStep(raw) > 0);
  });
});
