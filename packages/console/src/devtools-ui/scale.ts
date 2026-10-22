/**
 * Axis steps for the timelines.
 *
 * Shared because the Network overview and the waterfall draw the same axis
 * over the same data and had drifted into two copies of it — identical today,
 * which is exactly how two copies stay until one of them is fixed.
 */

/**
 * The nearest 1 / 2 / 5 × 10ⁿ at or above `raw`.
 *
 * Ticks land on numbers a person reads without counting zeros, which is the
 * whole job of an axis label.
 */
export function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

/**
 * The same idea for a span of time, snapped to durations people name.
 *
 * 1-2-5 is right for abstract quantities and wrong for clocks: it offers 20
 * and 50 seconds where a reader wants 30 seconds and a minute.
 */
const TIME_STEPS_MS = [10, 20, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];

export function niceTimeStep(raw: number): number {
  for (const s of TIME_STEPS_MS) if (raw <= s) return s;
  return TIME_STEPS_MS[TIME_STEPS_MS.length - 1]!;
}

/**
 * One tick's label, in the unit the whole axis is using.
 *
 * The Network timelines labelled each tick on its own with the duration
 * formatter the table cells use, and an axis is not a column of durations: a
 * run a little over a minute long came out
 * `20.00 s · 40.00 s · 1.0 min · 1.3 min`, which changes unit halfway along
 * and offers two decimals of precision on one tick and one on the next. A
 * reader of an axis wants the same unit under every mark and only as many
 * decimals as the step between them can tell apart.
 *
 * So the unit comes from the step rather than from the tick, and the number
 * of decimals from the step as well. Milliseconds only while the whole axis
 * is under a second — past that `1500 ms` is a worse way of writing `1.5 s`.
 *
 * `formatMs` is untouched and still right where it is used: a cell saying how
 * long one request took is a duration, and has nobody beside it to agree with.
 */
export function axisTime(ms: number, step: number, span: number): string {
  const [unit, suffix] = span < 1000 ? [1, 'ms'] : step >= 60_000 ? [60_000, 'min'] : [1000, 's'];
  const perStep = step / unit;
  const places = perStep >= 1 ? 0 : perStep >= 0.1 ? 1 : 2;
  return `${(ms / unit).toFixed(places)} ${suffix}`;
}
