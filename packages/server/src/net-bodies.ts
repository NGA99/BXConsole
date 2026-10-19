/**
 * Deciding what of a network event goes to the blob store.
 *
 * Response bodies are the bulk of a long run's network.ndjson, and that file
 * is read end to end every time someone opens the session — so a run that
 * moved a lot of JSON makes the Network tab slow to open, forever after.
 * Anything past a couple of kilobytes therefore goes to the store, which also
 * collapses the identical bodies a polled endpoint returns over and over into
 * a single copy on disk.
 *
 * The rule the whole arrangement rests on: a recording must never come out
 * with less in it than it went in. Every refusal here leaves the body exactly
 * where it was.
 */
import { BODY_INLINE_MAX_BYTES, type AgentEvent } from '@bxconsole/protocol';

/** The two event shapes that carry a body. */
type BodyEvent = Extract<AgentEvent, { type: 'network.request' } | { type: 'network.response' }>;

export function carriesBody(event: AgentEvent): event is BodyEvent {
  return event.type === 'network.request' || event.type === 'network.response';
}

/**
 * The body as bytes, or null when there is nothing worth moving.
 *
 * The encoding matters more than it looks: a base64 body is a string standing
 * in for bytes, and storing its characters as UTF-8 would hand back a
 * different file than the page saw.
 */
export function bodyOf(event: BodyEvent): { bytes: Buffer; mime: string } | null {
  const body = event.body;
  if (typeof body !== 'string' || body.length <= BODY_INLINE_MAX_BYTES) return null;
  const base64 = event.type === 'network.response' && event.bodyEncoding === 'base64';
  return {
    bytes: Buffer.from(body, base64 ? 'base64' : 'utf8'),
    // A response says what it is; a request only ever says so in its headers.
    mime: event.type === 'network.response' ? (event.mimeType ?? '') : contentType(event.headers),
  };
}

/**
 * The event with its body replaced by a reference to the stored bytes.
 *
 * The size travels separately from here on: every reader that showed it
 * measured the string that is no longer there.
 */
export function withBodyRef(event: BodyEvent, sha: string, bytes: number): BodyEvent {
  const { body: _moved, ...rest } = event;
  return { ...rest, bodyRef: sha, bodyBytes: bytes } as BodyEvent;
}

/** Header lookup that does not care how the page spelled the name. */
export function contentType(headers: Record<string, string>): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return v.split(';')[0]!.trim();
  }
  return '';
}
