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
 * A refusal used to leave the body inline, on the rule that a recording must
 * never come out with less in it than it went in. The rule is a good one and
 * that was the wrong place to apply it: the store refuses a body for being
 * over 4 MiB or for putting the session past its 50 MB budget, and sending
 * those to the event log instead meant the budget bounded nothing at all.
 * Past it, every body landed in a file with no ceiling, no compaction, and a
 * reader that goes through it end to end each time the session is opened —
 * so an ordinary long run on a busy app grew without limit, and a socket
 * that forged its own events could fill a disk on purpose.
 *
 * So a refused body is dropped and said to be dropped, with its size kept.
 * What is lost is a body the store had already decided not to hold; what is
 * kept is the fact that it existed and how big it was.
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

/**
 * The event with its body taken away and nothing put in its place.
 *
 * For a body the store would not hold. The size stays, so the Network panel
 * can still say how much went past even though none of it was kept.
 */
export function withBodyDropped(event: BodyEvent, bytes: number): BodyEvent {
  const { body: _gone, ...rest } = event;
  return { ...rest, bodyBytes: bytes, bodyDropped: true } as BodyEvent;
}

/** Header lookup that does not care how the page spelled the name. */
export function contentType(headers: Record<string, string>): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return v.split(';')[0]!.trim();
  }
  return '';
}
