/**
 * ArrayBuffer to base64, for bodies that are not text.
 *
 * In chunks because `String.fromCharCode(...bytes)` blows the argument limit
 * somewhere around a hundred kilobytes — which is exactly the size at which
 * someone first hits it, in a page nobody is watching.
 */
export function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
