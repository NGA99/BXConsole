/**
 * Reaching the rest of the run.
 *
 * The agent usually gets installed in one window, part-way through a flow that
 * already spans several. Two things follow from that:
 *
 *   up    the windows that opened this one are reachable through window.opener
 *         while they are same-origin, so the agent installs itself in each of
 *         them and the whole A -> B -> C chain joins the session.
 *   down  a window this page opens from now on gets the agent as it is created,
 *         and keeps getting it after every navigation of its own, since nothing
 *         inside a window can survive its own document being replaced. This is
 *         also what keeps `target="_blank"` links in the session: the browser
 *         gives those implicit noopener, so the agent opens them itself.
 *
 * None of this can run code before a document's own scripts: only a service
 * worker or an extension can. The gap is small but real, and events before the
 * agent lands are lost (resource timing is recovered, console output is not).
 */
import type { AgentConfig } from '../config';
import { getFlag, getHandle, setFlag } from '../mark';
import { agentUrl } from '../agent-url';

const MAX_DEPTH = 6;

type AgentWindow = Window & {
  __adopting?: never;
  /** installed by adoptChildren: hands this window a child to keep in the session */
  __watch?: never;
};

/** Install the agent in `win`, unless it already has one or we cannot touch it. */
function installInto(win: AgentWindow, config: AgentConfig, sessionId: string): boolean {
  try {
    if (!win || win.closed || getHandle(win) || getFlag(win, 'Adopting')) return false;
    const doc = win.document;
    if (!doc) return false;
    const script = doc.createElement('script');
    script.src = agentUrl(config, sessionId, location.href);
    (doc.head || doc.documentElement).appendChild(script);
    // Only after the append succeeded: a throw here must not block later attempts.
    setFlag(win, 'Adopting', true);
    return true;
  } catch {
    // cross-origin, or the window went away mid-call
    return false;
  }
}

/**
 * Walk window.opener upwards and install into every same-origin ancestor.
 * The chain breaks at the first window we cannot read: one opened by a
 * `target="_blank"` link (opener is null), one behind COOP, or a cross-origin
 * hop. Everything above that point stays out of the session.
 */
export function adoptOpeners(config: AgentConfig, sessionId: string): number {
  let reached = 0;
  let win: AgentWindow | null = null;
  try {
    win = window.opener as AgentWindow | null;
  } catch {
    return 0;
  }
  const seen = new Set<unknown>([window]);
  for (let depth = 0; win && depth < MAX_DEPTH; depth++) {
    if (seen.has(win)) break;
    seen.add(win);
    let next: AgentWindow | null = null;
    try {
      if (win.closed) break;
      // Touch the document first: it throws for a cross-origin window, and we
      // must not count or climb past one we cannot reach.
      void win.document;
      if (installInto(win, config, sessionId)) reached++;
      next = win.opener as AgentWindow | null;
    } catch {
      break;
    }
    win = next;
  }
  return reached;
}

const watched = new WeakSet<Window>();

/**
 * Keep another window carrying the agent for as long as it lives.
 *
 * One install is not enough: every navigation in that window drops the agent
 * with the old document, and nothing inside it can bring the agent back. So a
 * supervisor outside it watches and re-installs — which is the whole idea
 * behind both adoption and the iframe host.
 */
export function watchWindow(child: Window | null, config: AgentConfig, sessionId: string): () => void {
  if (!child || watched.has(child)) return () => undefined;
  watched.add(child);
  let lastHref: string | null = null;
  const timer = setInterval(() => {
    const c = child as AgentWindow;
    try {
      if (c.closed) return clearInterval(timer);
      if (!c.document || !c.document.head) return;
      const href = c.location.href;
      if (href === 'about:blank') return;
      if (href !== lastHref) {
        lastHref = href;
        setFlag(c, 'Adopting', false); // a new document: the old attempt does not count
      }
      if (!getHandle(c)) installInto(c, config, sessionId);
    } catch {
      // cross-origin for now; it may come back to our origin, so keep watching
    }
  }, 150);
  /*
   * Stop watching. A frame that was taken out of the page is not coming back,
   * and a poll that outlives it is a timer running for the life of the
   * document, swallowing an exception every 150ms for nobody's benefit.
   */
  return () => {
    clearInterval(timer);
    watched.delete(child);
  };
}

/**
 * Put the agent into windows this page opens from here on, and route
 * `target="_blank"` clicks through window.open so they keep their opener.
 */
export function adoptChildren(config: AgentConfig, sessionId: string): void {
  if (getFlag(window, 'OpenHooked')) return;
  setFlag(window, 'OpenHooked', true);

  const nativeOpen = window.open.bind(window);
  const arm = (child: Window | null) => watchWindow(child, config, sessionId);

  // Windows that already existed when we booted cannot be found by patching
  // window.open, so they ask us themselves (see askOpenerToWatch).
  setFlag(window, 'Watch', (child: Window) => arm(child));

  window.open = function patchedOpen(this: Window, ...args: Parameters<Window['open']>) {
    const child = nativeOpen(...args);
    arm(child);
    return child;
  } as Window['open'];

  document.addEventListener(
    'click',
    (ev) => {
      // Bubble phase, not capture: the page's own handlers run first, so one
      // that cancels the click (a router, a confirm step, an analytics hook)
      // is respected instead of getting an unwanted window anyway.
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const el = ev.target instanceof Element ? ev.target.closest('a[target="_blank"]') : null;
      if (!(el instanceof HTMLAnchorElement) || !el.href) return;
      if (!sameOrigin(el.href)) return;
      // Asking for a download, or for no opener: both are the author's choice and
      // taking them over would change what the page does. Only the browser's own
      // implicit noopener on target="_blank" is worth defeating, because it would
      // silently drop the new window out of the session.
      if (el.hasAttribute('download')) return;
      // noreferrer implies noopener, and both are the author refusing exactly
      // the link we would be creating.
      if (/\b(noopener|noreferrer)\b/i.test(el.rel)) return;
      ev.preventDefault();
      arm(nativeOpen(el.href));
    },
    false,
  );
}

function sameOrigin(href: string): boolean {
  try {
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Ask the window that opened this one to keep watching it.
 *
 * Climbing upwards puts the agent into the windows above, but it does not make
 * them watch this one: their `window.open` hook only sees windows they open
 * after booting, and this window already existed. Without this, a window the
 * agent reached by climbing loses the agent on its next navigation and never
 * gets it back. The opener's agent may still be loading, so keep asking for a
 * short while.
 */
export function askOpenerToWatch(): void {
  let tries = 0;
  const timer = setInterval(() => {
    let op: AgentWindow | null = null;
    try {
      op = window.opener as AgentWindow | null;
      if (!op || op.closed) return clearInterval(timer);
      const watch = getFlag(op, 'Watch');
      if (typeof watch === 'function') {
        (watch as (child: Window) => void)(window);
        clearInterval(timer);
        return;
      }
    } catch {
      return clearInterval(timer); // cross-origin opener
    }
    if (++tries > 60) clearInterval(timer);
  }, 100);
}
