/**
 * Wall-clock formatting, shared by the panels.
 *
 * Most of the UI measures time relative to something: a request's duration, an
 * offset from the first event. Those answer "how long", never "when", so every
 * place that shows a relative time should be able to show the clock time too,
 * and should carry the full timestamp in its tooltip.
 */

const p = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 14:03:27.412 — the Console's timestamp format. */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 14:03:27 — when milliseconds would just be noise. */
export function clockTimeShort(ts: number): string {
  const d = new Date(ts);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 2026-10-17 14:03:27.412 — unambiguous, for tooltips and session headers. */
export function fullTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${clockTime(ts)}`;
}

/**
 * "2026.10.19 21:03:27" — the date and the clock, always, whatever the age.
 *
 * `friendlyTimestamp` is the better read for something that happened a minute
 * ago, and the worse one for a column: "today" and "yesterday" change meaning
 * overnight while the page is still open, and neither can be matched against
 * a server log without doing the arithmetic yourself.
 */
export function absoluteTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${clockTimeShort(ts)}`;
}

/** "today 14:03:27", "yesterday 23:11:02", or the full stamp for anything older. */
export function friendlyTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `today ${clockTimeShort(ts)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${clockTimeShort(ts)}`;
  return fullTimestamp(ts);
}
