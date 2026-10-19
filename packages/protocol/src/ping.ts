/**
 * Connectivity probes.
 *
 * Before an agent can report anything, the page has to be able to reach the
 * relay — and "cannot reach" is several different problems wearing one face:
 * a wrong host, a blocked port, an https page refusing an http relay, or a
 * Content-Security-Policy that allows some kinds of subresource and not
 * others. The last one is the common case on a real intranet app, and it is
 * invisible from here: the console simply never hears anything.
 *
 * So the page is asked to fetch one URL per mechanism. CSP is enforced per
 * directive, so which probes arrive says which directive is in the way.
 */

/** One way of reaching the relay, and the CSP directive that governs it. */
export const PROBES = ['img', 'style', 'script', 'fetch', 'websocket'] as const;
export type Probe = (typeof PROBES)[number];

export const PROBE_DIRECTIVE: Record<Probe, string> = {
  img: 'img-src',
  style: 'style-src',
  script: 'script-src',
  fetch: 'connect-src',
  websocket: 'connect-src',
};

/** A probe that reached the relay. */
export interface ProbeArrival {
  /** distinguishes two arrivals of the same probe */
  id: string;
  token: string;
  probe: Probe;
  ts: number;
  method?: string;
  /** the path as requested, so a duplicate or a rewritten one is visible */
  path?: string;
  /** what the browser says it was fetching for: image, script, style, empty… */
  dest?: string;
  /** the page that made the request, when it tells us */
  referer?: string;
  /** reported by the script probe, which can read its own window */
  pageUrl?: string;
  ip?: string;
  userAgent?: string;
  /** every other header, in arrival order, with the secret ones left out */
  headers?: Record<string, string>;
  /** headers that were dropped rather than stored, so the gap is explicit */
  withheld?: string[];
  /**
   * What the page's own response says about being framed, reported by the
   * script probe. Read from headers rather than tried for real: framing a
   * page inside itself runs the whole app a second time.
   */
  framing?: { xFrameOptions: string; frameAncestors: string };
}

/**
 * Headers never kept.
 *
 * The relay has no login, so anyone who can reach it can read these records.
 * A page's cookie or bearer token would be someone's live session, and none
 * of it helps answer which way in is blocked.
 */
export const WITHHELD_HEADERS = ['cookie', 'set-cookie', 'authorization', 'proxy-authorization'];

/**
 * How long a diagnosis token is good for.
 *
 * A day, because the point of the Webhook tab is to paste a URL somewhere —
 * a page, a job, a colleague's terminal — and come back to it. Anything
 * shorter and the usual way of using it fails, silently, long after the
 * person stopped watching.
 */
export const PING_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** Where the live tokens are kept, so a relay restart does not void them. */
export const PING_TOKENS_FILE = 'ping-tokens.json';
/** Arrivals kept per token, and overall. Memory only — the relay has no login. */
export const PING_PER_TOKEN = 20;
export const PING_TOTAL = 200;

const TOKEN_RE = /^[A-Za-z0-9]{6,32}$/;
export function isValidPingToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function pingPath(probe: Probe, token: string): string {
  return `/ping/${probe}/${encodeURIComponent(token)}`;
}
