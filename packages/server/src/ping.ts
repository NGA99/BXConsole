/**
 * The connectivity probes behind `/ping/...`.
 *
 * Each route is one way a browser can be made to fetch something, and the
 * point is which of them arrive. A page whose CSP allows `img-src` but not
 * `script-src` will deliver the image and swallow the script, and that
 * difference is the diagnosis — see ping.ts in the protocol package for why
 * this exists at all.
 *
 * Nothing here is written to disk and nothing is kept for long. The relay has
 * no login, so anyone who can reach it could read these records; they hold a
 * client IP and a page URL, which is exactly the sort of thing not to leave
 * lying around.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  WITHHELD_HEADERS,
  PING_PER_TOKEN,
  PING_TOKEN_TTL_MS,
  PING_TOTAL,
  PROBES,
  isValidPingToken,
  type Probe,
  type ProbeArrival,
} from '@bxconsole/protocol';

/** A 1×1 transparent PNG, so the <img> probe resolves rather than erroring. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A live token: when it lapses, and the account that asked for it. */
interface Issued {
  until: number;
  /**
   * The account id that asked for this token.
   *
   * A probe record holds a client IP and the URL of the page it fired on, and
   * for a while any signed-in account could subscribe to any token and read
   * them — the token was the only thing asked for, and tokens are handed out
   * to whoever asks. So the board remembers who it handed each one to, and
   * only they can watch it.
   *
   * The account rather than the project because nothing chooses a project
   * when a token is issued: the console has no switcher yet. Per project is
   * the right shape once it has one, and this is the isolation that does not
   * need it.
   */
  owner: string;
}

export class PingBoard {
  /** live tokens, by token */
  private readonly tokens = new Map<string, Issued>();
  /**
   * Where to write them.
   *
   * A token is good for a week, and the relay is restarted far more often
   * than that — a build, a crash, a machine waking up. Keeping them only in
   * memory made that week a lie in the most confusing way available: the probe
   * still got a 200, so the page looked fine and the tab stayed empty.
   */
  private file: string | null = null;
  /** arrivals, newest last, bounded overall and per token */
  private arrivals: ProbeArrival[] = [];
  private readonly listeners = new Set<(a: ProbeArrival) => void>();

  /** A fresh token for one diagnosis run, for the account that asked. */
  issue(owner: string): { token: string; expiresAt: number } {
    this.sweep();
    const token = randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    const expiresAt = Date.now() + PING_TOKEN_TTL_MS;
    this.tokens.set(token, { until: expiresAt, owner });
    this.persist();
    return { token, expiresAt };
  }

  /**
   * Keep tokens in this file, and take back the ones already in it.
   *
   * Lapsed entries are dropped on the way in, so the file cannot grow without
   * end, and a file that cannot be read is simply an empty board — a broken
   * one must not stop the relay starting.
   */
  useFile(file: string): void {
    this.file = file;
    try {
      const held = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const now = Date.now();
      for (const [token, value] of Object.entries(held)) {
        if (!isValidPingToken(token)) continue;
        /*
         * A bare number is the old format, from before tokens had an owner,
         * and those are dropped rather than taken in as anybody's.
         *
         * Letting them through would mean keeping the leak they were written
         * under for as long as they last — a week — and the leak is the part
         * nobody can see. A dropped token is visible and fixable instead:
         * the console asks whether a token is live before it listens, and
         * says "expired, make a new one" when it is not.
         */
        if (typeof value !== 'object' || value === null) continue;
        const { until, owner } = value as Partial<Issued>;
        if (typeof until !== 'number' || until <= now) continue;
        if (typeof owner !== 'string' || !owner) continue;
        this.tokens.set(token, { until, owner });
      }
    } catch {
      /* no file yet, or an unreadable one: start empty */
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.tokens)));
    } catch {
      /* the tokens still work for this run; they just will not outlive it */
    }
  }

  /**
   * Whether a token is one we handed out and has not lapsed.
   *
   * No account here, and there cannot be one: this is what the probe routes
   * ask, and they are reached by a victim's browser with nobody at the
   * keyboard. It says whether to record an arrival, not who may read it.
   */
  knows(token: string): boolean {
    const issued = this.tokens.get(token);
    if (issued === undefined) return false;
    if (issued.until <= Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** Whether this account is the one this token was handed to. */
  isOwnedBy(token: string, accountId: string | undefined): boolean {
    if (accountId === undefined) return false;
    return this.knows(token) && this.tokens.get(token)?.owner === accountId;
  }

  /** What has arrived so far for a token, oldest first, for its owner. */
  since(token: string, accountId: string | undefined): ProbeArrival[] {
    if (!this.isOwnedBy(token, accountId)) return [];
    return this.arrivals.filter((a) => a.token === token);
  }

  record(arrival: ProbeArrival): void {
    this.arrivals.push(arrival);
    // Per token first, so one noisy page cannot push out everyone else's.
    const mine = this.arrivals.filter((a) => a.token === arrival.token);
    if (mine.length > PING_PER_TOKEN) {
      const drop = new Set(mine.slice(0, mine.length - PING_PER_TOKEN));
      this.arrivals = this.arrivals.filter((a) => !drop.has(a));
    }
    if (this.arrivals.length > PING_TOTAL) this.arrivals = this.arrivals.slice(-PING_TOTAL);
    for (const listen of this.listeners) listen(arrival);
  }

  onArrival(listener: (a: ProbeArrival) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, issued] of this.tokens) if (issued.until <= now) this.tokens.delete(token);
  }
}

/** `/ping/{probe}/{token}` — the probe and token, or null if it is neither. */
export function parseProbePath(pathname: string): { probe: Probe; token: string } | null {
  const m = /^\/ping\/([a-z]+)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const probe = m[1] as Probe;
  if (!PROBES.includes(probe)) return null;
  const token = decodeURIComponent(m[2]!);
  return isValidPingToken(token) ? { probe, token } : null;
}

let seq = 0;

/**
 * Everything a probe request tells us, minus what must not be kept.
 *
 * The headers are worth having in full: an `x-forwarded-for` names the real
 * client behind a proxy, a rewritten `user-agent` says one is there at all,
 * and a `sec-fetch-*` set says what the browser thought it was doing. None of
 * that fits in a five-row matrix.
 */
export function describeRequest(
  headers: Record<string, string | string[] | undefined>,
  ip: string | undefined,
  method?: string,
  path?: string,
) {
  const flat: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (WITHHELD_HEADERS.includes(key)) {
      withheld.push(key);
      continue;
    }
    flat[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
  }
  return {
    id: `a${++seq}`,
    ...(method ? { method } : {}),
    ...(path ? { path } : {}),
    ...(flat['sec-fetch-dest'] ? { dest: flat['sec-fetch-dest'] } : {}),
    ...(flat['referer'] ? { referer: flat['referer'] } : {}),
    ...(flat['user-agent'] ? { userAgent: flat['user-agent'] } : {}),
    ...(ip ? { ip } : {}),
    headers: flat,
    ...(withheld.length ? { withheld } : {}),
  };
}

/**
 * The second stage, served as the `script` probe's body.
 *
 * It runs only if `script-src` allowed it, which is the point: the probes it
 * fires in turn — fetch and WebSocket, both governed by `connect-src` — are
 * only meaningful once we know scripts run at all. Driving every probe from
 * JavaScript would have told us nothing in the case we most need to diagnose.
 */
export function scriptProbeBody(origin: string, token: string, wsOrigin: string): string {
  const json = JSON.stringify;
  return `(function () {
  var origin = ${json(origin)}, token = ${json(token)};
  var page = '';
  try { page = location.href; } catch (e) {}

  /*
   * Whether this page may be put in a frame, which is what the agent's iframe
   * option would need. Read from the page's own response rather than tried for
   * real: framing the page inside itself would run the whole app a second
   * time, with every side effect that implies.
   *
   * Same-origin, so every response header is readable here. CSP
   * frame-ancestors overrides X-Frame-Options where both are set, so both are
   * reported and the console decides.
   */
  function framing(done) {
    var give = function (res) {
      if (!res) return done('');
      var xfo = res.headers.get('x-frame-options') || '';
      var csp = res.headers.get('content-security-policy') || '';
      var fa = '';
      csp.split(';').forEach(function (part) {
        if (/^\\s*frame-ancestors\\b/i.test(part)) fa = part.trim();
      });
      return done('&xfo=' + encodeURIComponent(xfo.slice(0, 120)) + '&fa=' + encodeURIComponent(fa.slice(0, 300)));
    };
    try {
      fetch(location.href, { method: 'HEAD', cache: 'force-cache' })
        .then(function (r) { return r.ok ? give(r) : fetch(location.href, { cache: 'force-cache' }).then(give, function () { done(''); }); },
              function () { done(''); });
    } catch (e) { done(''); }
  }

  framing(function (extra) {
    try {
      fetch(origin + '/ping/fetch/' + token + '?page=' + encodeURIComponent(page) + extra, { mode: 'cors' }).catch(function () {});
    } catch (e) {}
  });

  try {
    var ws = new WebSocket(${json(wsOrigin)} + '/ping/websocket/' + token);
    ws.onopen = function () { try { ws.close(); } catch (e) {} };
  } catch (e) {}
})();
`;
}

export const PROBE_BODIES: Record<Exclude<Probe, 'websocket' | 'script'>, { type: string; body: Buffer }> = {
  img: { type: 'image/png', body: PIXEL },
  // Valid CSS and nothing else: the body is served into someone else's page,
  // so it must not say who sent it.
  style: { type: 'text/css', body: Buffer.from('\n', 'utf8') },
  fetch: { type: 'application/json', body: Buffer.from('{"ok":true}', 'utf8') },
};
