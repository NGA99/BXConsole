/**
 * Whether a response body is text.
 *
 * Both sides ask this and they must agree. The agent asks it to decide
 * whether to ship a body as a string or as base64; the console asks it to
 * decide how to render what came back. When the two disagreed — and they did,
 * in three regexes that each knew about a different handful of types — an SVG
 * went out as text from one path and came back expecting base64 on another.
 */

/** Strip `; charset=…` and case, which is all anyone ever means by the type. */
export function mimeType(raw: string): string {
  return raw.split(';')[0]!.trim().toLowerCase();
}

/**
 * True for anything a person would read as text.
 *
 * An empty or missing type is **not** text here: the agent must not decode
 * unlabelled bytes as a string and mangle them. A caller that would rather
 * guess text — the console rendering something already stored — says so
 * itself, which keeps the guess where someone can see it.
 */
export function isTextualMime(raw: string): boolean {
  const type = mimeType(raw);
  if (!type) return false;
  if (type.startsWith('text/')) return true;
  if (/\+(json|xml)$/.test(type)) return true;
  if (type === 'image/svg+xml') return true;
  return /^application\/(json|xml|javascript|ecmascript|x-javascript|x-www-form-urlencoded|wasm-text|yaml|x-yaml|csv)$/.test(type);
}
