/**
 * Where the body for a selected request should come from.
 *
 * Four places, in order of how much they can be trusted: the event itself,
 * the relay's blob store, a fresh read from inside the page, and nowhere.
 * Only the first two are the original response; a re-read is a new request
 * that merely stands in for it, and the drawer says so when it shows one.
 *
 * Kept apart from the hook because the two bugs this had were both about
 * which source applies, not about React: a second row showed the first row's
 * body, and a run that had ended still spent fifteen seconds asking a page
 * that was gone.
 */
import type { NetworkEntry } from '../../state/session-data';

export type BodySource =
  /** the bytes are in the event, exactly as the page saw them */
  | { from: 'event' }
  /** the relay holds them under this content hash */
  | { from: 'store'; sha: string }
  /**
   * The event does not carry them. Ask the relay, which answers from what it
   * kept during the run if it kept this file, and otherwise asks the page.
   * An ended run is not a reason to skip this: everything the run collected
   * is still there, and that is most of why it was collected.
   */
  | { from: 'ask' }
  /** nobody has them and nobody can be asked */
  | { from: 'nowhere'; why: 'not-re-readable' | 'no-response' };

export function bodySource(entry: NetworkEntry): BodySource {
  const res = entry.response;
  const inEvent = !entry.resource && res?.body != null && !res.bodyTruncated && res.responseType !== 'opaque';
  if (inEvent) return { from: 'event' };

  if (!entry.resource && res?.bodyRef) return { from: 'store', sha: res.bodyRef };

  // An opaque response is one the page itself could not read, and a WebSocket
  // has frames rather than a body. Neither has anything to go and fetch.
  if (res?.responseType === 'opaque' || entry.request.kind === 'websocket') return { from: 'nowhere', why: 'no-response' };

  /*
   * Asking may end in a fresh GET for the URL, which stands in for the
   * original only when the original was a GET: replaying `POST /orders` as
   * `GET /orders` would show the order list as if it were the POST's
   * response, and would hit an endpoint nobody asked for.
   *
   * The relay answers from its own store first, and a stored body is the
   * real one however the request was made — but the console cannot tell from
   * here which it will be, and guessing wrong in this direction would issue
   * the request. So a non-GET is refused, and a POST whose body the run did
   * collect is the one case this gives up on unnecessarily.
   */
  if (entry.request.method.toUpperCase() !== 'GET') return { from: 'nowhere', why: 'not-re-readable' };

  // Connected or not, the relay is worth asking: it may have kept this file,
  // and it says plainly when it has not.
  return { from: 'ask' };
}
