/**
 * Axis ticks. Two panels drew the same axis from two copies of this, and the
 * History panel a third that only looked like the others — it snaps to
 * durations people name, because 1-2-5 offers 20 and 50 seconds where a
 * reader wants 30 seconds and a minute.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { niceStep, niceTimeStep, axisTime } from '../src/devtools-ui/scale';

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

describe('axisTime', () => {
  /** What one axis of ticks reads as, start to finish. */
  const axis = (span: number, step: number) => {
    const out: string[] = [];
    for (let t = step; t < span; t += step) out.push(axisTime(t, step, span));
    return out;
  };

  test('the unit does not change halfway along the axis', () => {
    // The run that prompted this: 20.00 s · 40.00 s · 1.0 min · 1.3 min.
    const labels = axis(95_000, 15_000);
    assert.deepEqual(labels, ['15 s', '30 s', '45 s', '60 s', '75 s', '90 s']);
  });

  test('as many decimals as the step can tell apart, and no more', () => {
    assert.deepEqual(axis(3000, 500), ['0.5 s', '1.0 s', '1.5 s', '2.0 s', '2.5 s']);
    assert.deepEqual(axis(900, 200), ['200 ms', '400 ms', '600 ms', '800 ms']);
  });

  test('milliseconds only while the whole axis is under a second', () => {
    // Past that, 1500 ms is a worse way of writing 1.5 s.
    assert.equal(axisTime(500, 100, 800), '500 ms');
    assert.equal(axisTime(500, 100, 4000), '0.5 s');
  });

  test('minutes once the step itself is a minute', () => {
    assert.deepEqual(axis(1_200_000, 300_000), ['5 min', '10 min', '15 min']);
    // Two and a half minutes in half-minute steps still reads in seconds:
    // 0.5 min is a worse way of writing 30 s.
    assert.deepEqual(axis(150_000, 30_000), ['30 s', '60 s', '90 s', '120 s']);
  });

  test('every label on one axis has the same unit and the same precision', () => {
    // The digits differ from tick to tick; the unit and the number of places
    // after the point are what must not.
    for (const span of [700, 5_000, 95_000, 600_000, 4_000_000, 60_000_000]) {
      const step = niceTimeStep(span / 6);
      const labels = axis(span, step);
      const shapes = new Set(labels.map((l) => `${l.split(' ')[1]}/${(l.split(' ')[0]!.split('.')[1] ?? '').length}`));
      assert.equal(shapes.size, 1, `${span}ms gave ${labels.join(' · ')}`);
    }
  });
});
