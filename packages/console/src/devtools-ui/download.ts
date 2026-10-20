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
  return size === undefined ? `${stem}-${when}.${ext}` : `${stem}-${size}chars-${when}.${ext}`;
}
