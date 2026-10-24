/**
 * What a page is allowed to write into the relay's own index.
 *
 * `page.navigated` and `page.title` carry the url and title straight from the
 * debugged page into `meta.json`, and `AgentEvent` is a TypeScript type —
 * there is nothing at runtime between the socket and the file. A run that
 * reported `url: null, title: 12` had exactly that written to disk, where it
 * stayed: the console learned to render it anyway, but the stored metadata
 * was still wrong, and an export, another tool or a person reading the
 * directory met the bad value again.
 *
 * Two rules, and the second one matters as much as the first.
 *
 * A field that is not a string is dropped rather than coerced. `String(12)`
 * would put `"12"` in the index as though the page had said so, and this file
 * is the relay's record of what it was told. Dropping leaves the field as it
 * was, which is the truth: the page said nothing usable this time. Nothing is
 * lost either way — the event itself is already in the session's ndjson,
 * verbatim, which is where the evidence lives.
 *
 * A field longer than a page could plausibly mean is cut. The index is read
 * in full every time the console lists sessions, and a page that navigates to
 * a fifty-megabyte url would otherwise put it in that list, once per
 * navigation. The whole value stays in the event stream.
 */
import type { SessionTab } from '@bxconsole/protocol';

/** Generous for a real address: a data: URL that long is already pathological. */
export const URL_MAX = 4096;
/** Generous for a real title; the longest real one anybody has is a sentence. */
export const TITLE_MAX = 1024;

export function usableTabPatch(patch: Partial<SessionTab>): Partial<SessionTab> {
  const out: Partial<SessionTab> = { ...patch };
  keep(out, 'url', URL_MAX);
  keep(out, 'title', TITLE_MAX);
  // A flag the page reports; anything that is not a boolean says nothing.
  if ('hidden' in out && typeof out.hidden !== 'boolean') delete out.hidden;
  return out;
}

function keep(out: Partial<SessionTab>, field: 'url' | 'title', max: number): void {
  if (!(field in out)) return;
  const value: unknown = out[field];
  if (typeof value !== 'string') delete out[field];
  else if (value.length > max) out[field] = value.slice(0, max);
}
