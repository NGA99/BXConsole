/**
 * Ids that stay unique across the windows of one session.
 *
 * Request ids and object ids are plain counters that restart at 1 in every
 * window. A session can hold several windows, and the console indexes both by
 * id alone, so without a per-window prefix window B's `r1` would overwrite
 * window A's and responses would land on the wrong row.
 */
let prefix = '';

/**
 * Called once at boot, as soon as the window knows which tab it is.
 *
 * The document token matters as much as the tab: counters restart at 1 in
 * every document, and the tab id survives reloads, so without it the ids of
 * one page load repeat exactly in the next and the console answers an expand
 * from the previous document's cache.
 */
export function setIdPrefix(tabId: string): void {
  const doc = Math.random().toString(36).slice(2, 7);
  prefix = `${tabId}.${doc}-`;
}

export function scopedId(value: string | number): string {
  return `${prefix}${value}`;
}
