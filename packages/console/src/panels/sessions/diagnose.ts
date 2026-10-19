/**
 * Reading the probe matrix.
 *
 * This is the whole value of the Webhook tab: five arrivals, or the lack
 * of them, turned into one sentence a person can act on. Kept apart from the
 * panel because it is pure, and because a wrong sentence here sends someone
 * looking at their firewall when the problem is a CSP header.
 */
import { PROBES, type Probe } from '@bxconsole/protocol';

export type Arrived = Partial<Record<Probe, true>>;

export interface Verdict {
  tone: 'blocked' | 'partial' | 'ok';
  headline: string;
  detail: string;
}

/**
 * The question after every probe gets through: did an agent actually start?
 *
 * Every way in being open is not the end of it — the page still has to run
 * the agent and say hello. Answering it here is what keeps someone from
 * concluding "connectivity is fine" and then staring at an empty Sessions
 * list wondering what else is wrong.
 */
export function agentVerdict(sessionUrls: string[], pageUrl: string | undefined): Verdict {
  const origin = originOf(pageUrl);
  const from = origin === null ? [] : sessionUrls.filter((u) => originOf(u) === origin);
  if (from.length) {
    return {
      tone: 'ok',
      headline: 'Every way through is open, and an agent is reporting',
      detail: `A session from ${origin} is in the list — this page is already being recorded.`,
    };
  }
  return {
    tone: 'ok',
    headline: 'Every way through is open',
    detail: origin
      ? `Nothing is blocked, but no session has started from ${origin} yet. Install the agent on this page.`
      : 'Install the agent on this page.',
  };
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * What the arrivals add up to, or null when none have come.
 *
 * Null rather than "nothing has arrived": before anything is pasted anywhere,
 * nothing arriving is not a finding, and saying the page cannot reach the
 * relay would be an accusation with no evidence behind it. The inbox already
 * says it is waiting.
 */
export function readMatrix(arrived: Arrived): Verdict | null {
  const has = (p: Probe) => arrived[p] === true;
  if (!PROBES.some(has)) return null;

  if (!has('script')) {
    return {
      tone: 'blocked',
      headline: 'The network is fine; scripts are blocked',
      detail:
        "The image or stylesheet arrived and the script did not. The page's CSP `script-src` does not allow this relay — the agent will not load for the same reason.",
    };
  }

  if (!has('fetch') && !has('websocket')) {
    return {
      tone: 'blocked',
      headline: 'Scripts run, but nothing can connect',
      detail: 'The script loaded, and neither the fetch nor the WebSocket arrived. CSP `connect-src` does not allow this relay.',
    };
  }

  if (has('fetch') && !has('websocket')) {
    return {
      tone: 'partial',
      headline: 'HTTP works, the WebSocket does not',
      detail:
        'The agent will load but cannot open its live channel. Something in between is eating the upgrade, or the CSP allows this origin without its ws: address.',
    };
  }

  if (!has('fetch') && has('websocket')) {
    return {
      tone: 'partial',
      headline: 'The WebSocket works, fetch does not',
      detail: 'The live stream will connect, but requests for file contents are blocked — Sources and Network bodies may come up empty.',
    };
  }

  const missing = PROBES.filter((p) => !has(p));
  if (missing.length) {
    return {
      tone: 'partial',
      headline: 'Everything the agent needs is through',
      detail: `${missing.join(', ')} did not arrive, so that kind of resource is blocked and parts of the Screen mirror may be empty.`,
    };
  }

  return {
    tone: 'ok',
    headline: 'Every way through is open',
    detail: 'Install the agent on this page.',
  };
}

/** The URL a probe is reached at. */
export function urlFor(origin: string, probe: Probe, token: string): string {
  const base = `${origin}/ping/${probe}/${token}`;
  return probe === 'websocket' ? base.replace(/^http/, 'ws') : base;
}

/** The markup that fetches a probe, for the three that have any; null for the rest. */
export function tagFor(origin: string, probe: Probe, token: string): string | null {
  const url = urlFor(origin, probe, token);
  if (probe === 'img') return `<img src="${url}" alt="" hidden>`;
  if (probe === 'style') return `<link rel="stylesheet" href="${url}">`;
  if (probe === 'script') return `<script src="${url}"></script>`;
  // fetch and the socket are fired by the script probe once it is allowed to
  // run, so they have no markup of their own.
  return null;
}

/** All three tags, in the order the layering needs. */
export function snippetFor(origin: string, token: string): string {
  return (['img', 'style', 'script'] as const).map((p) => tagFor(origin, p, token)!).join('\n');
}

/** Whether the page may be put in a frame, and what said so. */
export interface Framing {
  can: boolean;
  /** nothing in the page's response speaks to it either way */
  silent: boolean;
  why: string;
}

/**
 * Read a page's framing headers.
 *
 * The agent's iframe option needs the page to host a frame of itself, which
 * is a same-origin frame. `frame-ancestors` overrides `X-Frame-Options`
 * wherever both are set, so it is consulted first — a page that still sends
 * the old header alongside a permissive CSP is framable, and saying otherwise
 * would talk someone out of an option that works.
 */
export function readFraming(xFrameOptions: string, frameAncestors: string, pageUrl?: string): Framing {
  const fa = frameAncestors.trim();
  if (fa) {
    const tokens = fa
      .replace(/^frame-ancestors/i, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase().replace(/^'|'$/g, ''));
    if (tokens.includes('none')) return { can: false, silent: false, why: "the page's CSP says frame-ancestors 'none'" };
    if (tokens.includes('self') || tokens.includes('*')) {
      return { can: true, silent: false, why: `the page's CSP allows it (${fa})` };
    }
    const origin = originOf(pageUrl);
    if (origin && tokens.some((t) => t === origin || t === origin.replace(/^https?:\/\//, ''))) {
      return { can: true, silent: false, why: `the page's CSP lists its own origin (${fa})` };
    }
    return { can: false, silent: false, why: `the page's CSP allows only other origins (${fa})` };
  }

  const xfo = xFrameOptions.trim().toLowerCase();
  if (xfo === 'deny') return { can: false, silent: false, why: 'the page sends X-Frame-Options: DENY' };
  if (xfo === 'sameorigin') return { can: true, silent: false, why: 'the page sends X-Frame-Options: SAMEORIGIN' };
  if (xfo.startsWith('allow-from')) {
    // Browsers dropped ALLOW-FROM; the header has no effect, so nothing forbids it.
    return { can: true, silent: false, why: `X-Frame-Options: ${xFrameOptions.trim()} is ignored by browsers, so nothing forbids it` };
  }
  if (xfo) return { can: true, silent: false, why: `X-Frame-Options: ${xFrameOptions.trim()} is not a value browsers act on` };
  return { can: true, silent: true, why: 'nothing in the page’s response forbids it' };
}
