/**
 * Whether a row's response body can still be read, and from where.
 *
 * A picture is not a special case here. The relay keeps images for the Screen
 * mirror, so an image whose bytes it holds is `stored` and the Preview tab
 * can draw it; one nobody kept is `live-only` or `lost` like anything else.
 * `none` is for rows where no copy would help.
 *
 * The Network tab answers this for every row at once, before anyone clicks:
 * "is this still here" is the question a reader has while scanning a
 * recording, and asking per row only ever answers for the row already open.
 *
 * Five states in three bands. The bands are what matters to a reader — it is
 * here, it is only here while the run is — and the split inside each band is
 * what matters when they want to know why.
 */
import type { NetworkEntry } from '../../state/session-data';

export type BodyState =
  /** the agent caught it as it happened; it is in the recording */
  | 'captured'
  /** the relay keeps a copy of the file; readable long after the run */
  | 'stored'
  /** nobody kept it, but the page is still up and can be asked */
  | 'live-only'
  /** nobody kept it and the run has ended: there is nowhere left to look */
  | 'lost'
  /** nothing can be shown for this row, whatever anyone kept */
  | 'none';

/** The three groupings a reader actually scans for. */
export const BAND: Record<BodyState, 'local' | 'live' | 'never'> = {
  captured: 'local',
  stored: 'local',
  'live-only': 'live',
  lost: 'never',
  none: 'never',
};

export const LABEL: Record<BodyState, string> = {
  captured: 'Captured',
  stored: 'Stored',
  'live-only': 'Live only',
  lost: 'Lost',
  none: 'None',
};

export const TITLE: Record<BodyState, string> = {
  captured: 'The agent captured this body as the response arrived. It is part of the recording.',
  stored: 'The relay kept a copy of this file, so it reads back long after the run has ended.',
  'live-only': 'Nothing kept this body. It can still be re-read from the page while the run is live — after that it is gone.',
  lost: 'Nothing kept this body and the run has ended, so there is nowhere left to read it from.',
  none: 'Nothing can be shown for this row: a response the page itself could not read, a socket that carries frames rather than a body, or a request that cannot be safely repeated to ask again.',
};

/**
 * @param kept     urls the relay is holding, from the files.list manifest
 * @param connected whether any window of the run is still live
 */
export function bodyState(entry: NetworkEntry, kept: ReadonlySet<string>, connected: boolean): BodyState {
  const res = entry.response;

  // In the event already. A truncated body is not the body, so it does not count.
  if (!entry.resource && res?.body != null && !res.bodyTruncated && res.responseType !== 'opaque') return 'captured';
  // Moved out of the event into the store, but still this run's own bytes.
  if (!entry.resource && res?.bodyRef) return 'captured';

  // An opaque response is one the page itself could not read, and a WebSocket
  // carries frames rather than a body.
  if (res?.responseType === 'opaque' || entry.request.kind === 'websocket') return 'none';

  /*
   * Re-reading means a fresh GET for the URL, which stands in for the
   * original only when the original was a GET. Replaying `POST /orders` as
   * `GET /orders` would show the order list as if it were the POST's
   * response, and would hit an endpoint nobody asked for. So a non-GET whose
   * body was not captured has nothing that can be done for it.
   */
  if (entry.request.method.toUpperCase() !== 'GET') return 'none';

  if (kept.has(entry.request.url)) return 'stored';
  return connected ? 'live-only' : 'lost';
}

/** Sorting puts what is readable first and what is gone last. */
export const BODY_ORDER: Record<BodyState, number> = {
  captured: 0,
  stored: 1,
  'live-only': 2,
  lost: 3,
  none: 4,
};
