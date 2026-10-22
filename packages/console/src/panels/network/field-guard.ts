/**
 * Network fields as the types claim they are.
 *
 * A `NetworkEntry` is assembled straight from the agent's events, so its
 * `headers` can arrive as null and its `url`, `method` or `body` as a number.
 * `Object.entries(null)` throws, and so does `.split` on a number: in the
 * Network grid that unmounted the panel, and in the context menu it broke
 * "Copy as cURL" with nothing on screen to say why.
 *
 * These are deliberately small and total. Where a chokepoint existed the
 * coercion went there instead (see `transport/reply-guard.ts` and
 * `state/sessions.ts`); the entries come from the event stream, which this
 * audit does not own, so the panel's own readers are guarded here.
 */

/** A field typed as a string, as a string. */
export function textOf(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** A header map as name/value pairs, whatever the page actually sent. */
export function headerPairs(v: unknown): Array<[string, string]> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [];
  return Object.entries(v).map(([name, value]) => [name, textOf(value)]);
}

/** One header's value, or '' — the name is matched case-insensitively, as HTTP means it. */
export function headerOf(v: unknown, name: string): string {
  const want = name.toLowerCase();
  for (const [k, value] of headerPairs(v)) if (k.toLowerCase() === want) return value;
  return '';
}

/** How many headers there are, for the section titles. */
export function headerCount(v: unknown): number {
  return headerPairs(v).length;
}
