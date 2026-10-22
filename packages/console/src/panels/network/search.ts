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
import { textOf, textOfUrl, urlIsBinary, type UnloadedBody } from './stored-bodies';
import { bodyState } from './body-state';
import { headerOf, headerPairs } from './field-guard';

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
  /** bodies the relay is holding and this search did not see */
  unloaded: UnloadedBody[];
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
  /**
   * The bodies the relay holds under a url rather than a hash.
   *
   * `kept` is the files manifest — the same set the Body column reads to say
   * "Stored" — and only those are offered for fetching. `bodySource` would
   * also answer "ask" for a body nobody kept, and that asks the page, which
   * would turn a search into a round of fresh requests the operator never
   * made.
   */
  byUrl: {
    kept?: ReadonlySet<string>;
    sessionId?: string;
    text?: (session: string, url: string) => string | null;
    /** fetched already and not text, so there is nothing left to offer */
    binary?: (session: string, url: string) => boolean;
  } = {},
): SearchResult {
  const kept = byUrl.kept ?? new Set<string>();
  const sessionId = byUrl.sessionId ?? '';
  const loadedUrl = byUrl.text ?? textOfUrl;
  const alreadyBinary = byUrl.binary ?? urlIsBinary;
  if (!query) return { hits: [], unloaded: [] };
  let rx: RegExp;
  try {
    rx = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return { hits: [], unloaded: [] };
  }
  const hits: SearchHit[] = [];
  const unloaded = new Map<string, UnloadedBody>();
  /**
   * @param from  where in `text` the part worth showing begins.
   *
   * A header is searched as "name: value" so that a query can match either,
   * and shown as the value alone — the name is already the label, and
   * "x-trace: x-trace: trace-0" is what showing both looked like. A match
   * inside the name leaves nothing to mark in the value; the label carries
   * the highlight in that case.
   */
  const test = (requestId: string, where: SearchHit['where'], raw: string | null | undefined, label?: string, from = 0) => {
    // Bodies and header values come from the page, so `raw` is a string only
    // by type; a number would reach .slice below.
    const text = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw);
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

  /**
   * The other kind of kept body: no content hash, held by the relay under the
   * url it was fetched from. Most of what a run collects is one of these, and
   * this search used to pass over every one of them without a word — which is
   * the one thing the note at the top of this file says it must never do.
   */
  const viaUrl = (e: NetworkEntry, where: SearchHit['where']) => {
    const mime = e.response?.mimeType;
    if (mime && !isTextualMime(mime)) return;
    const url = e.request.url;
    const text = loadedUrl(sessionId, url);
    if (text !== null) test(e.requestId, where, text);
    // Not offered again once it has been fetched and turned out to be bytes:
    // a mime type is often missing on a resource-timing entry, so this is the
    // only point at which some bodies can be known not to be worth grepping.
    else if (!alreadyBinary(sessionId, url)) unloaded.set(`url:${url}`, { url, ...(mime ? { mime } : {}) });
  };

  for (const e of entries) {
    test(e.requestId, 'url', e.request.url);
    // headerPairs, not Object.entries: the page reported these maps, and
    // Object.entries throws on the null one it is free to send.
    for (const [k, v] of headerPairs(e.request.headers)) test(e.requestId, 'request header', `${k}: ${v}`, k, k.length + 2);
    for (const [k, v] of headerPairs(e.response?.headers)) test(e.requestId, 'response header', `${k}: ${v}`, k, k.length + 2);

    if (e.request.body != null) test(e.requestId, 'request body', e.request.body);
    else viaStore(e.requestId, 'request body', e.request.bodyRef, headerOf(e.request.headers, 'content-type'));

    if (e.response?.body != null) {
      if (e.response.bodyEncoding !== 'base64') test(e.requestId, 'response body', e.response.body);
    } else if (e.response?.bodyRef) {
      viaStore(e.requestId, 'response body', e.response.bodyRef, e.response.mimeType);
    } else if (bodyState(e, kept, false) === 'stored') {
      viaUrl(e, 'response body');
    }

    for (const f of e.frames ?? []) test(e.requestId, 'ws message', f.data);
  }
  return { hits, unloaded: [...unloaded.values()] };
}
