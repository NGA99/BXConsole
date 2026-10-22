/**
 * What this browser remembers about one run, and letting go of it.
 *
 * Two settings are kept per run, each under a key of its own: the Network
 * tab's blocked patterns and cache flag, and the Console's live expressions.
 * When a recording is deleted for good the relay drops the whole directory
 * and the console drops its buffers, its DOM model and its completion cache —
 * and left these two behind, with nothing that would ever remove them.
 *
 * That is worth more than the few bytes it costs. "Delete this recording for
 * good" is the one button in this console that promises something is gone,
 * and on an engagement it is the one somebody presses because the recording
 * holds a client's traffic. A list of URL patterns from that client's site,
 * still sitting in the operator's browser afterwards, is the promise not
 * being kept.
 */

/** The little of localStorage this needs, so a test can hand it something else. */
export interface KeyStore {
  removeItem(key: string): void;
}

/** One entry each, named after the run they belong to. */
export const PER_SESSION_PREFIXES = ['bxconsole.network.config.', 'bxconsole.live.'] as const;

export function keysFor(sessionId: string): string[] {
  return PER_SESSION_PREFIXES.map((p) => p + sessionId);
}

/**
 * @param store  defaults to this page's localStorage, or nothing at all where
 *               there is none — a private window forgets anyway, which is the
 *               outcome this is reaching for.
 */
export function forgetSessionStorage(sessionId: string, store: KeyStore | null = defaultStore()): void {
  // An empty id would build the bare prefixes and delete nothing; it is still
  // worth refusing, because a prefix is a key somebody may add later.
  if (!store || !sessionId) return;
  for (const key of keysFor(sessionId)) {
    try {
      store.removeItem(key);
    } catch {
      /* out of reach: the run is gone from the relay either way */
    }
  }
}

function defaultStore(): KeyStore | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
