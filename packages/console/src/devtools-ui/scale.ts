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
