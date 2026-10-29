/**
 * The selected row's response body, from wherever it can be had — and what
 * the drawer says when it cannot be had at all.
 *
 * Both tabs that show a body (Preview and Response) ask the same question and
 * answer "there isn't one" the same four ways, which is why the hook and the
 * notices are one file rather than one each.
 */
import { useEffect, useReducer, type ReactElement } from 'react';
import type { SourceText } from '@bxconsole/protocol';
import type { NetworkEntry } from '../../../state/session-data';
import { sourceText } from '../../../transport/client';
import { held, load } from '../stored-bodies';
import { bodySource } from '../body-source';
import { Empty } from './bits';

/**
 * Bodies the agent did not capture (resources seen only through resource timing,
 * fetches made before the hook, truncated bodies) are fetched from inside the page
 * on demand, cache-first, the same way the Sources tab reads files. Not the original
 * response bytes, so the UI says so.
 */
const lazyBodies = new Map<string, SourceText>();
/** Re-reads in progress, so selecting a row twice does not ask the page twice. */
const asking = new Set<string>();

export interface LoadedBody {
  body: string | null;
  mimeType: string | undefined;
  base64: boolean;
  fromPage: boolean;
  loading: boolean;
  error?: string;
  /** the body is missing and re-reading it would mean issuing a different request than this row */
  notReReadable?: boolean;
}

/**
 * The body for the selected row, from wherever it can be had.
 *
 * Everything is read from the module caches during render rather than copied
 * into state. Copying was the bug: `useState` runs its initialiser once per
 * component, this drawer is reused as the selection moves from row to row,
 * and so a second request showed the first one's body — or, because the
 * effect saw a body already in hand, never loaded at all.
 */
export function useBody(entry: NetworkEntry, sessionId: string): LoadedBody {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const res = entry.response;
  const source = bodySource(entry);
  const ref = source.from === 'store' ? source.sha : undefined;
  // Keyed by the request, not the URL: two rows on one endpoint, or the same
  // URL after a reload, are different responses and must not share a body.
  const key = `${sessionId}|${entry.requestId}`;

  useEffect(() => {
    if (!ref || held(ref)) return;
    let live = true;
    void load(sessionId, ref, res?.mimeType).then(() => {
      if (live) rerender();
    });
    return () => {
      live = false;
    };
  }, [ref, sessionId, res?.mimeType]);

  const askRelay = source.from === 'ask';
  useEffect(() => {
    if (!askRelay || lazyBodies.has(key) || asking.has(key)) return;
    let live = true;
    asking.add(key);
    rerender();
    void sourceText(sessionId, entry.request.url).then((r) => {
      lazyBodies.set(key, r ?? { url: entry.request.url, text: null, error: 'no reply from the page' });
      asking.delete(key);
      if (live) rerender();
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, askRelay]);

  const blank = { body: null, mimeType: res?.mimeType, base64: false, fromPage: false, loading: false } satisfies LoadedBody;

  switch (source.from) {
    case 'event':
      return { body: res!.body!, mimeType: res!.mimeType, base64: res!.bodyEncoding === 'base64', fromPage: false, loading: false };
    case 'store': {
      const stored = held(source.sha);
      if (!stored) return { ...blank, loading: true };
      if ('error' in stored) return { ...blank, error: stored.error };
      return { body: stored.text, mimeType: res?.mimeType, base64: stored.base64, fromPage: false, loading: false };
    }
    case 'ask': {
      const fetched = lazyBodies.get(key);
      if (!fetched) return { ...blank, loading: true };
      return {
        body: fetched.text,
        mimeType: fetched.mimeType ?? res?.mimeType,
        base64: fetched.encoding === 'base64',
        // A body the relay kept during the run is the real one; only a fresh
        // read from the page carries the "this may differ" caveat.
        fromPage: !fetched.fromStore,
        loading: false,
        ...(fetched.error ? { error: fetched.error } : {}),
      };
    }
    case 'nowhere':
      return {
        ...blank,
        ...(source.why === 'not-re-readable' ? { notReReadable: true } : {}),
      };
  }
}

/**
 * The body was not captured and this row is not a GET, so there is nothing safe to re-read:
 * the agent would have to send a different request than the one being shown.
 */
export function NotReReadable({ method }: { method: string }) {
  return (
    <Empty>
      This response body was not captured. BXConsole only re-reads a body by issuing a GET for the URL, which would not be
      this {method.toUpperCase()} request, so it was not attempted.
    </Empty>
  );
}

export function FromPageNote({ loaded }: { loaded: LoadedBody }) {
  if (!loaded.fromPage) return null;
  return (
    <span
      className="detail-note"
      title="The agent did not capture this body; it was re-fetched inside the page (cache-first), so it may differ from the original response"
    >
      fetched from page
    </span>
  );
}

/**
 * The four ways a body can be absent, in the order the tabs ask about them.
 *
 * Preview and Response had this chain written out twice, line for line. It is
 * a render helper rather than a component so a tab can go on to its own
 * rendering when the answer is `null` — there is a body.
 */
export function missingBody(entry: NetworkEntry, loaded: LoadedBody): ReactElement | null {
  if (loaded.loading) return <Empty>Loading from the page…</Empty>;
  if (loaded.body != null) return null;
  if (entry.failed) return <Empty>Request failed.</Empty>;
  if (loaded.error) return <Empty>Could not load the body: {loaded.error}</Empty>;
  if (loaded.notReReadable) return <NotReReadable method={entry.request.method} />;
  return (
    <Empty>
      {entry.response || entry.resource ? 'This request has no response data available.' : 'Waiting for response…'}
    </Empty>
  );
}
