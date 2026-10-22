/**
 * Handing something in the console to the operator as a file.
 *
 * Everything here is already in the page — a recorded body, a HAR, a string
 * too long to read in a row — so this never asks the relay for anything. It
 * wraps what is in memory and lets the browser save it.
 */

/** Save `text` as a file. The blob URL is released once the click is through. */
export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Long enough for the download to have started; the object would otherwise
  // be held for the life of the document.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A filename nobody has to rename: what it is, how big, and when.
 *
 * The size is in the name because the clock is not enough on its own —
 * saving several values in the same second gave them all one name, and the
 * browser then numbered them (1), (2), which says nothing about which is
 * which. It also means a file found weeks later describes itself.
 */
export function stampedName(stem: string, ext: string, size?: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const safe = filename(stem);
  return size === undefined ? `${safe}-${when}.${ext}` : `${safe}-${size}chars-${when}.${ext}`;
}

/**
 * A stem that every filesystem will take.
 *
 * The stems are not all literals: a HAR is named after the host the run was
 * on, and a host carries its port, so `localhost:7331` went out as a filename
 * with a colon in it — illegal on Windows, and shown as a slash by the
 * Finder. A page's host can also be an IPv6 address in brackets.
 *
 * Everything outside the set a filename can safely hold becomes a dash, and
 * runs of dashes collapse so a host does not come out looking padded.
 */
function filename(stem: string): string {
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'download';
}
