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

export type StoredBody = { text: string; base64: boolean } | { error: string };

const cache = new Map<string, StoredBody>();
/** in-flight fetches, so two callers asking at once make one request */
const inFlight = new Map<string, Promise<StoredBody>>();

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
export async function loadAll(sessionId: string, refs: Array<{ sha: string; mime?: string }>, concurrency = 6): Promise<void> {
  const queue = refs.filter((r) => !cache.has(r.sha));
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let r = queue.pop(); r; r = queue.pop()) await load(sessionId, r.sha, r.mime);
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
