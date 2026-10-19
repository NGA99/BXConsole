/**
 * On-disk layout for persisted session data, relative to the repo root:
 *
 *   sessions/
 *     session-{sessionId}/
 *       meta.json          SessionMeta
 *       console.ndjson     console.* and error.* events, one SequencedEvent per line
 *       network.ndjson     network.* events
 *       page.ndjson        page.* events
 *       history.ndjson     interaction.*, perf.*, mark.*, dom.activity events (History tab)
 *       screen.ndjson      the Screen recording: one ScreenRecord per line,
 *                          keyframes (`{"k":1`) interleaved with op batches,
 *                          trimmed from the front once it passes the budget
 *
 * The console UI mirrors this as a route: #/sessions/session-{sessionId}/{panel}
 */

export const SESSIONS_DIR = 'sessions';

/**
 * A session id comes from the page (`?session=` on the agent URL), and it ends
 * up in a filesystem path that the relay writes to and, on forget, removes
 * recursively. Anything but a plain token is refused: `../..` would otherwise
 * walk out of sessions/ and delete whatever it pointed at.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId);
}

export const sessionDirName = (sessionId: string): string => {
  if (!isValidSessionId(sessionId)) throw new Error(`refusing to use ${JSON.stringify(sessionId)} as a session id`);
  return `session-${sessionId}`;
};

export const SESSION_FILES = {
  meta: 'meta.json',
  console: 'console.ndjson',
  network: 'network.ndjson',
  page: 'page.ndjson',
  history: 'history.ndjson',
} as const;

export type SessionFile = keyof typeof SESSION_FILES;

/** The Screen recording, which is keyed by time rather than by `seq`. */
export const SCREEN_LOG_FILE = 'screen.ndjson';
/** Pre-timeline single frame, still read so older session dirs keep working. */
export const SCREEN_FRAME_FILE = 'screen.json';

/**
 * Script every agent runs the moment it installs, held on the relay.
 *
 * A blind XSS window may be open for eight seconds. By the time anyone has
 * noticed the session and opened a console, the page is gone — so whatever
 * you wanted from it has to be taken without a person in the loop. This is
 * that: arbitrary JS, run once per agent, after the hooks are in place so
 * whatever it fetches or logs is captured like any other page activity.
 *
 * It is global, which is the thing to be careful about. The relay has no
 * authentication, so anyone who can reach it can set this, and every agent
 * that connects afterwards will run it — in every engagement on that relay.
 * Reading recordings is one thing; this is code execution in someone else's
 * browser. Do not expose a relay that has one of these set.
 */
export const PRE_PAYLOAD_FILE = 'pre-payload.js';
/** Nothing longer is served: it travels inline with every agent.js request. */
export const PRE_PAYLOAD_MAX_BYTES = 64 * 1024;

/** Per-session retention budget for the Screen recording; oldest keyframes go first. */
export const SCREEN_LOG_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Subresources (images, stylesheets, fonts) the page fetched for the Screen
 * mirror. They live beside the recording so a replay still has pictures long
 * after the page is gone.
 */
export const ASSET_DIR = 'assets';
/** Per-session budget for those; once it is full new assets are served but not kept. */
export const ASSET_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Bytes fetched from the debugged pages, stored once by content hash and
 * shared by every session that saw them. A session keeps only the mapping —
 * which url it saw holding which bytes — so a file that changed between runs
 * is still read back as each run saw it.
 */
export const BLOB_DIR = 'blobs';
/** The per-session mapping: one ndjson line per url, newest last. */
export const SESSION_FILES_INDEX = 'files.ndjson';
/**
 * Request and response bodies this session put in the store, one line each.
 *
 * Separate from files.ndjson because a body is not a url: one endpoint
 * polled every second is one url and a hundred different bodies, so the
 * newest-line-per-url rule that makes files.ndjson right would make this
 * wrong. Keyed by content hash instead, which also means a hundred identical
 * poll responses are one copy on disk.
 */
export const SESSION_BODIES_INDEX = 'bodies.ndjson';
/**
 * Bodies at or under this stay inline in network.ndjson.
 *
 * Most bodies are small, and a small body costs more as a hash, a line in
 * bodies.ndjson and a file of its own than it does where it already is.
 */
export const BODY_INLINE_MAX_BYTES = 2 * 1024;
/** Nothing larger is stored: a huge bundle costs as much as a video. */
export const BLOB_MAX_BYTES = 4 * 1024 * 1024;

/** Which ndjson file an event type lands in. */
export function fileForEventType(type: string): SessionFile | null {
  if (type.startsWith('console.') || type.startsWith('error.')) return 'console';
  if (type.startsWith('network.')) return 'network';
  if (type.startsWith('page.')) return 'page';
  if (type.startsWith('interaction.') || type.startsWith('perf.') || type.startsWith('mark.') || type === 'dom.activity') return 'history';
  return null;
}
