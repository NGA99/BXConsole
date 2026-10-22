/**
 * Response and request bodies the relay moved into its blob store.
 *
 * A recorded run keeps anything past a couple of kilobytes out of
 * network.ndjson and leaves a content hash on the event instead, so the file
 * stays small enough to re-read every time a session is opened. The bytes
 * come back from `/body/{sessionId}/{sha}` on demand.
 *
 * One cache for the whole panel, keyed by hash: the body view and the search
 * both want the same bytes, and content-addressed bytes cannot become
 * different bytes, so fetching them twice would be pure waste.
 */
import { isTextualMime, mimeType } from '@bxconsole/protocol';
import { sourceText } from '../../transport/client';

export type StoredBody = { text: string; base64: boolean } | { error: string };

/** A body a search did not look in: held by hash, or held by url. */
export type UnloadedBody = { sha: string; mime?: string } | { url: string; mime?: string };

const cache = new Map<string, StoredBody>();
/** in-flight fetches, so two callers asking at once make one request */
const inFlight = new Map<string, Promise<StoredBody>>();

/*
 * The other kind of kept body, and why it needs a cache of its own.
 *
 * Most of what a run collects never gets a content hash: the relay kept the
 * file during the run and holds it under its url, which is what the Body
 * column means by "Stored". Those are not content-addressed, so they cannot
 * share the map above — the same url can hold different bytes in two runs.
 * Keyed by session and url for that reason.
 */
const byUrl = new Map<string, StoredBody>();
const urlInFlight = new Map<string, Promise<StoredBody>>();
const urlKey = (sessionId: string, url: string) => `${sessionId}\n${url}`;

/** The text of a loaded url-held body, or null when it is absent or binary. */
export function textOfUrl(sessionId: string, url: string): string | null {
  const got = byUrl.get(urlKey(sessionId, url));
  if (!got || 'error' in got || got.base64) return null;
  return got.text;
}

/**
 * Fetched, and turned out not to be text.
 *
 * A body nobody has fetched and one that came back as bytes both have no
 * text, and the search has to tell them apart: the first is worth offering
 * to fetch, the second has been looked at and there is nothing in it to
 * match. Without this the panel went on saying "2 bodies were not searched"
 * after they had been, with a button that fetched them again from the cache
 * and changed nothing.
 */
export function urlIsBinary(sessionId: string, url: string): boolean {
  const got = byUrl.get(urlKey(sessionId, url));
  return !!got && !('error' in got) && got.base64;
}

export function loadUrl(sessionId: string, url: string): Promise<StoredBody> {
  const key = urlKey(sessionId, url);
  const done = byUrl.get(key);
  if (done) return Promise.resolve(done);
  const running = urlInFlight.get(key);
  if (running) return running;
  const job = sourceText(sessionId, url)
    .then<StoredBody>((got) => {
      if (!got || got.text == null) return { error: got?.error ?? 'the relay did not answer for this body' };
      return { text: got.text, base64: got.encoding === 'base64' };
    })
    .catch<StoredBody>((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
    .then((result) => {
      byUrl.set(key, result);
      urlInFlight.delete(key);
      return result;
    });
  urlInFlight.set(key, job);
  return job;
}

export function held(sha: string): StoredBody | undefined {
  return cache.get(sha);
}

/** The text of a loaded body, or null when it is absent, failed or binary. */
export function textOf(sha: string): string | null {
  const got = cache.get(sha);
  if (!got || 'error' in got || got.base64) return null;
  return got.text;
}

export function load(sessionId: string, sha: string, mime: string | undefined): Promise<StoredBody> {
  const done = cache.get(sha);
  if (done) return Promise.resolve(done);
  const running = inFlight.get(sha);
  if (running) return running;
  const job = fetchBody(sessionId, sha, mime).then((result) => {
    cache.set(sha, result);
    inFlight.delete(sha);
    return result;
  });
  inFlight.set(sha, job);
  return job;
}

/** Load several, a few at a time, so a search does not open sixty sockets at once. */
export async function loadAll(sessionId: string, refs: UnloadedBody[], concurrency = 6): Promise<void> {
  const queue = refs.filter((r) => ('sha' in r ? !cache.has(r.sha) : !byUrl.has(urlKey(sessionId, r.url))));
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let r = queue.pop(); r; r = queue.pop()) {
      if ('sha' in r) await load(sessionId, r.sha, r.mime);
      else await loadUrl(sessionId, r.url);
    }
  });
  await Promise.all(workers);
}

async function fetchBody(sessionId: string, sha: string, mime: string | undefined): Promise<StoredBody> {
  try {
    const res = await fetch(`/body/${sessionId}/${sha}`);
    if (!res.ok) return { error: `the relay no longer has this body (HTTP ${res.status})` };
    const buf = await res.arrayBuffer();
    // An unlabelled stored body is read as text on purpose: it is almost
    // always a document or a script, and showing bytes for one helps nobody.
    const declared = mime ?? res.headers.get('content-type') ?? '';
    if (!mimeType(declared) || isTextualMime(declared)) return { text: new TextDecoder().decode(buf), base64: false };
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { text: btoa(bin), base64: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
