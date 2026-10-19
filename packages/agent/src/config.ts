/**
 * Agent configuration, highest priority first:
 *
 *   1. data-* attributes on the <script> tag that loaded us
 *        data-name     session name shown in the Sessions tab
 *        data-server   ws(s):// URL of the relay
 *        data-bodies   "0" to skip capturing request/response bodies
 *        data-screen   "viewer" to stream the DOM only while a Screen tab is
 *                      open; the default records from boot, so History can
 *                      time-travel over the whole run
 *        data-frame    "off" to leave the page where it is; the default puts
 *                      it inside a full-page iframe and keeps the agent in
 *                      the window around it, so navigating does not end the run
 *        data-collect  "0" to stop the relay fetching and keeping the files
 *                      the page loads as it loads them
 *        data-mark     the token every trace left in the page is named from;
 *                      change it per engagement
 *        ?pre=1        ask the relay for the stored pre-payload; the script
 *                      itself only ever arrives through the injected config
 *   2. the config global the relay injects when it serves agent.js
 *      (its own public origin + the ?name= ?server= ?bodies= query); this is
 *      what makes `import("https://relay/agent.js")` and bookmarklets work,
 *      where there is no script tag to look at
 *   3. the origin of the script tag's src
 *   4. the page's own origin (last resort)
 */
import { INJECT_GLOBAL, WS_PATH, type InjectedConfig } from '@bxconsole/protocol';

/**
 * What the relay prepends to the bundle. The field names are the query
 * parameters, from one shared list, so the two cannot drift again.
 */
type Injected = Partial<InjectedConfig>;



export interface AgentConfig {
  name: string | null;
  /** URL the agent was loaded from; used to strip our own stack frames */
  scriptSrc: string | null;
  serverUrl: string;
  captureBodies: boolean;
  /** max characters of a body/string to ship before truncating */
  maxBodyLength: number;
  /**
   * `record`  stream from boot (default), so the Screen can be replayed at
   *           any point of the run; costs CPU in the page throughout
   * `viewer`  stream only while a Screen tab is open
   */
  screen: 'viewer' | 'record';
  /** `data-session` / `?session=`: join this session instead of the stored one */
  sessionId: string | null;
  /** `data-tab` / `?tab=`: be this window within the session, set by a supervisor */
  tabId: string | null;
  /**
   * Install into the windows that opened this one and into the ones it opens,
   * so a flow spanning several windows lands in one session. `data-adopt="0"`
   * turns it off and keeps the agent to this window.
   */
  adopt: boolean;
  /**
   * `host`  (default) the top window keeps nothing but a full-page iframe of
   *         the app, and re-installs the agent into that frame after every
   *         navigation, so one run spans them. Only possible where the page
   *         allows itself to be framed — the Webhook tab reads that from its
   *         headers, and a page that refuses shows nothing at all.
   * `off`   the agent lives in the page, and a navigation ends the run.
   */
  frame: 'off' | 'host';
  /**
   * Let the relay fetch and keep the scripts, stylesheets and documents this
   * page loads, as it loads them. Without it those bytes are only fetched
   * when someone opens the file in the console — which, after the run has
   * ended, is never, because the page that could fetch them is gone.
   *
   * Only subresources the browser already loaded are eligible, so a fetch is
   * always a repeat of something the page did itself.
   */
  collect: boolean;
  /**
   * The token every trace in the page is named from (see mark.ts). Set it per
   * engagement: a fixed value, however bland, is still one grep for a
   * defender who has seen it before.
   */
  mark: string | null;
  /**
   * Script the relay handed us to run at install (see pre-payload.ts).
   *
   * Read only from the injected config, never from a data attribute or the
   * script's own query: the source has to come from the relay, or a page able
   * to shape its agent's URL could choose what that agent executes.
   */
  pre: string | null;
}

export function readConfig(): AgentConfig {
  const script = findOwnScriptTag();
  const ds = script?.dataset ?? {};
  const injected = ((globalThis as unknown as Record<string, unknown>)[INJECT_GLOBAL] as Injected | undefined) ?? {};
  const scriptSrc = script?.src ?? (injected.origin ? `${injected.origin}/agent.js` : null);

  return {
    name: ds.name ?? injected.name ?? null,
    scriptSrc,
    serverUrl: ds.server ?? injected.server ?? toWsUrl(injected.origin) ?? deriveServerUrl(script?.src),
    captureBodies: (ds.bodies ?? injected.bodies) !== '0',
    maxBodyLength: 64 * 1024,
    // Every option below is on unless the snippet turns it off, so a snippet
    // carrying nothing is a run with everything enabled — which is what the
    // Agent tab hands out, and why its default snippet is a bare script tag.
    screen: (ds.screen ?? injected.screen ?? queryParam(scriptSrc, 'screen')) === 'viewer' ? 'viewer' : 'record',
    sessionId: ds.session ?? queryParam(scriptSrc, 'session') ?? null,
    tabId: ds.tab ?? queryParam(scriptSrc, 'tab') ?? null,
    adopt: (ds.adopt ?? injected.adopt ?? queryParam(scriptSrc, 'adopt')) !== '0',
    frame: (ds.frame ?? injected.frame ?? queryParam(scriptSrc, 'frame')) === 'off' ? 'off' : 'host',
    collect: (ds.collect ?? injected.collect ?? queryParam(scriptSrc, 'collect')) !== '0',
    mark: ds.mark ?? injected.mark ?? queryParam(scriptSrc, 'mark') ?? null,
    pre: injected.pre ?? null,
  };
}

function toWsUrl(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const u = new URL(origin);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}${WS_PATH.agent}`;
  } catch {
    return undefined;
  }
}

function findOwnScriptTag(): HTMLScriptElement | null {
  const current = document.currentScript as HTMLScriptElement | null;
  if (current) return current;
  // Fallback for async/module loads where currentScript is null.
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'));
  return scripts.find((s) => /agent(\.min)?\.js(\?|$)/.test(s.src)) ?? null;
}

function deriveServerUrl(scriptSrc: string | undefined): string {
  // A browser resolves a script's `src` before we ever read it, so this
  // should not be able to fail. Guarded anyway because the failure mode is
  // the worst available: readConfig throws, no hook is installed, and the
  // page looks exactly like one the agent was never pasted into.
  const base = parseUrl(scriptSrc, location.href) ?? parseUrl(location.href);
  const proto = base?.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${base?.host ?? ''}${WS_PATH.agent}`;
}

function parseUrl(url: string | undefined, base?: string): URL | null {
  if (!url) return null;
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** Read a query parameter off the agent's own script URL (…/agent.js?session=abc). */
function queryParam(src: string | null, key: string): string | null {
  if (!src) return null;
  try {
    return new URL(src, location.href).searchParams.get(key);
  } catch {
    return null;
  }
}
