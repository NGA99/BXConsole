/**
 * What a cell of the session list says, apart from how it is drawn.
 *
 * Six small rules, each with an edge: a boundary in hours, a split of a
 * budget, a count that must not read `0/0`, a name the page chose. Those are
 * the parts of a row that go wrong quietly — a column that says "23h ago"
 * when it means a week, a tooltip that reads backwards — so they live here,
 * beside the table rather than inside it, where they can be read against
 * their own tests. `purge.ts` is the same arrangement for the trash deadline.
 */
import type { SessionMeta } from '@bxconsole/protocol';
import { plain } from '../../devtools-ui/plain-text';
import { absoluteTimestamp } from '../../devtools-ui/time';

/**
 * Why the list is empty, which is four different things.
 *
 * It read the project rather than the listing, and so answered the wrong
 * question twice: a project whose only recordings were in the trash said "No
 * session matches the filter" with no filter typed, and a trash whose rows
 * were all hidden by one said "The trash is empty" when it held two. Both
 * came of asking "does this project have anything" when the reader is asking
 * "where did the rows go".
 *
 * The filter is the first thing to rule out, because it is the one the reader
 * did themselves and the one they can undo.
 */
export type EmptyReason = 'filtered' | 'trash-empty' | 'elsewhere' | 'nothing-yet';

export function emptyReason({ trash, hidden, elsewhere }: { trash: boolean; hidden: number; elsewhere: number }): EmptyReason {
  if (hidden > 0) return 'filtered';
  if (trash) return 'trash-empty';
  return elsewhere > 0 ? 'elsewhere' : 'nothing-yet';
}

/** Everything the row calls this session, for the tooltip the name carries. */
export function identity(s: SessionMeta): string {
  return [plain(s.name), plain(s.title), `session-${s.sessionId}`].filter(Boolean).join('\n');
}

/**
 * The user agent, plus the viewport under it.
 *
 * The viewport is not in the user agent and is worth knowing — a 390-wide
 * window is a phone whatever the string claims. It had a column of its own
 * until the row became one line. Zero is what a recording made before the
 * window reported its size looks like, and "0×0" would state something false.
 */
export function agentTitle(s: SessionMeta): string {
  const size = s.viewport.width > 0 && s.viewport.height > 0 ? `${s.viewport.width}×${s.viewport.height}` : null;
  return [s.userAgent || 'no user agent reported', size].filter(Boolean).join('\n');
}

/**
 * Long URLs (search pages, signed links) would otherwise fill the row and push
 * everything else out. Cut the middle, not the end: the origin says which site
 * it is and the tail usually says which page. The full URL is in the tooltip.
 */
export function shortenUrl(url: string, max = 100): string {
  if (url.length <= max) return url;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${url.slice(0, head)}…${url.slice(-tail)}`;
}

/**
 * Windows in the run, and how many still have a live agent.
 *
 * The fallbacks are for a recording made before the agent reported its
 * windows: there the run is the one window it was, read as live or not from
 * the session itself. `tabs` is required of everything sent today.
 */
export function windowCount(s: SessionMeta): number {
  return s.tabs?.length ?? 1;
}
export function liveWindows(s: SessionMeta): number {
  return s.tabs?.filter((t) => t.connected).length ?? (s.connected ? 1 : 0);
}

/**
 * How long ago, for a column that is scanned rather than read.
 *
 * `now` is a parameter so the boundaries can be tested without waiting an
 * hour for one; nothing passes it.
 */
export function relative(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  // absoluteTimestamp, not the locale: a column is read against a server
  // log, and this one sits under rows that say "3m ago" in English.
  return absoluteTimestamp(ts);
}
