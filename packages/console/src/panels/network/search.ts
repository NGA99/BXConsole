/**
 * DevTools Network search: headers, payloads and response bodies of every
 * captured request.
 *
 * A recorded run keeps its larger bodies in the relay's blob store rather
 * than in the event, so some of what a search is asked to look through is not
 * in memory. Fetching all of it to answer a keystroke would be the wrong
 * shape — so the search reports what it could not look in, and the panel
 * offers to go and get it. What it must never do is come back "no matches"
 * having quietly skipped the only place the answer was.
 */
import { isTextualMime } from '@bxconsole/protocol';
import type { NetworkEntry } from '../../state/session-data';
import { textOf } from './stored-bodies';

export interface SearchHit {
  requestId: string;
  where: 'url' | 'request header' | 'response header' | 'request body' | 'response body' | 'ws message';
  /**
   * What to put at the head of the line, which for a header is its name.
   *
   * `where` says which part of the request matched and is the same half-dozen
   * words over and over; a reader scanning results wants to see `accept` or
   * `set-cookie`, the way the request itself would show it.
   */
  label: string;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** bodies held in the store and not loaded, so this search did not see them */
  unloaded: Array<{ sha: string; mime?: string }>;
}

/** What to call a match that is not a named header. */
const DEFAULT_LABEL: Record<SearchHit['where'], string> = {
  url: 'URL',
  'request header': 'Request header',
  'response header': 'Response header',
  'request body': 'Request payload',
  'response body': 'Response body',
  'ws message': 'Message',
};

const MAX_HITS = 300;
const SNIPPET = 80;

/**
 * @param loaded  the text of an already-fetched stored body, or null when it
 *                is not here. Injected rather than reached for, so this stays
 *                a pure function of its arguments and can be tested without a
 *                relay to fetch from.
 */
export function searchEntries(
  entries: NetworkEntry[],
  query: string,
  opts: { regex: boolean; caseSensitive: boolean },
  loaded: (sha: string) => string | null = textOf,
): SearchResult {
  if (!query) return { hits: [], unloaded: [] };
  let rx: RegExp;
  try {
    rx = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return { hits: [], unloaded: [] };
  }
  const hits: SearchHit[] = [];
  const unloaded = new Map<string, { sha: string; mime?: string }>();
  /**
   * @param from  where in `text` the part worth showing begins.
   *
   * A header is searched as "name: value" so that a query can match either,
   * and shown as the value alone — the name is already the label, and
   * "x-trace: x-trace: trace-0" is what showing both looked like. A match
   * inside the name leaves nothing to mark in the value; the label carries
   * the highlight in that case.
   */
  const test = (requestId: string, where: SearchHit['where'], text: string | null | undefined, label?: string, from = 0) => {
    if (!text || hits.length >= MAX_HITS) return;
    rx.lastIndex = 0;
    const m = rx.exec(text);
    if (!m) return;
    const shown = text.slice(from);
    const at = Math.max(0, m.index - from);
    const start = Math.max(0, at - SNIPPET / 2);
    hits.push({
      requestId,
      where,
      label: label ?? DEFAULT_LABEL[where],
      snippet: (start ? '…' : '') + shown.slice(start, start + SNIPPET).replace(/\s+/g, ' '),
    });
  };

  /**
   * A body that lives in the store: search it if it is already loaded, and
   * otherwise say so. Binary is skipped either way, as an inline base64 body
   * always has been — searching an encoding matches nothing a person meant.
   */
  const viaStore = (requestId: string, where: SearchHit['where'], ref: string | undefined, mime: string | undefined) => {
    if (!ref) return;
    if (mime && !isTextualMime(mime)) return;
    const text = loaded(ref);
    if (text === null) unloaded.set(ref, { sha: ref, ...(mime ? { mime } : {}) });
    else test(requestId, where, text);
  };

  for (const e of entries) {
    test(e.requestId, 'url', e.request.url);
    for (const [k, v] of Object.entries(e.request.headers)) test(e.requestId, 'request header', `${k}: ${v}`, k, k.length + 2);
    for (const [k, v] of Object.entries(e.response?.headers ?? {})) test(e.requestId, 'response header', `${k}: ${v}`, k, k.length + 2);

    if (e.request.body != null) test(e.requestId, 'request body', e.request.body);
    else viaStore(e.requestId, 'request body', e.request.bodyRef, e.request.headers['content-type']);

    if (e.response?.body != null) {
      if (e.response.bodyEncoding !== 'base64') test(e.requestId, 'response body', e.response.body);
    } else {
      viaStore(e.requestId, 'response body', e.response?.bodyRef, e.response?.mimeType);
    }

    for (const f of e.frames ?? []) test(e.requestId, 'ws message', f.data);
  }
  return { hits, unloaded: [...unloaded.values()] };
}
