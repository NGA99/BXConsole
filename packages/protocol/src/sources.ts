/** Sources tab (read-only): what the page has loaded, and its text on demand. */

export interface SourceEntry {
  /** real URL, or `inline://script/N` / `inline://style/N` for inline blocks */
  url: string;
  kind: 'document' | 'script' | 'stylesheet';
  inline: boolean;
  /** display name, e.g. "(index)", "app.js", "(inline script 2)" */
  label: string;
}

export interface SourceText {
  url: string;
  /** text, or base64 when `encoding` is set */
  text: string | null;
  mimeType?: string;
  encoding?: 'base64';
  error?: string;
  truncated?: boolean;
  /**
   * The relay served this from its own store rather than asking the page.
   *
   * It matters to the reader: these are bytes the page handed over during
   * this run, so they are what the run saw. A fresh read from the page is a
   * new request that only stands in for the original, and the console says
   * so — it must not say so about these.
   */
  fromStore?: boolean;
}

/**
 * One subresource fetched from inside the debugged page: an image, a
 * stylesheet, a font. `body` is base64 whatever the type, because the same
 * path carries binary and text and base64 is the only thing the JSON
 * transport takes either way.
 */
export interface AssetData {
  url: string;
  /** base64; absent when the fetch failed */
  body?: string;
  mimeType?: string;
  status?: number;
  /** why the page could not read it: CORS, HTTP status, size cap */
  error?: string;
}

/**
 * One file the relay is holding for a session.
 *
 * The Network tab needs this before anyone clicks a row: whether a body can
 * still be read is a property of every row at once, and asking per row only
 * answers for the row already open.
 */
export interface KeptFile {
  url: string;
  bytes: number;
  mime: string;
}
