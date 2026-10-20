/**
 * Hash router mirroring the on-disk layout:
 *
 *   #/sessions                               Sessions list (full width)
 *   #/webhook                                the same page, showing what a page managed to send us
 *   #/trash                                  the same page, showing the trash
 *   #/agent                                  the same page, showing the agent: options, snippets, source
 *   #/projects                               the same page, managing this account's projects
 *   #/admin                                  the same page, managing accounts and who owns what
 *   #/sessions/session-{id}/elements         a session, Elements tab active on the right
 *   #/sessions/session-{id}/console          a session, Console tab active on the right
 *   #/sessions/session-{id}/network          a session, Network tab active on the right
 *   #/sessions/session-{id}/history          a session, History tab active on the right
 *
 * The Screen mirror is always docked on the left of a session view, so it
 * has no route of its own; the legacy `/screen` path opens the Console tab.
 * Opening the same URL in another browser tab gives you a second DevTools
 * window on that session, which is how "open console for C, D, E" works.
 */
import { useEffect, useState } from 'react';

export type PanelId = 'sessions' | 'elements' | 'console' | 'sources' | 'network' | 'history';

/**
 * The faces of the sessions page, in the order they are shown. They are
 * routes rather than local state so each can be linked to, reloaded into, and
 * reached with the back button — the Webhook view in particular is something
 * you leave open, paste from, and come back to.
 *
 * `admin` is drawn only for an administrator, but it is a route like the rest:
 * hiding the tab is what the console does with it, and refusing what it asks
 * for is what the relay does. Reaching it by typing the address shows an
 * empty screen rather than somebody else's accounts.
 */
export const SESSION_VIEWS = ['sessions', 'webhook', 'trash', 'agent', 'projects', 'admin'] as const;
export type SessionView = (typeof SESSION_VIEWS)[number];

/** What those views used to be called, so a link made earlier still lands. */
const RENAMED: Record<string, SessionView> = { connectivity: 'webhook', install: 'agent', diagnose: 'webhook' };

export interface Route {
  panel: PanelId;
  sessionId: string | null;
  /** which face of the sessions page; only meaningful when `panel` is 'sessions' */
  view: SessionView;
}

const SESSION_RE = /^#\/sessions\/session-([^/]+)\/(elements|console|sources|network|history|screen)\/?$/;
const VIEW_RE = /^#\/([a-z]+)\/?$/;

export function parseHash(hash: string): Route {
  const m = SESSION_RE.exec(hash);
  if (m) {
    const p = m[2]!;
    const panel: PanelId = p === 'network' || p === 'elements' || p === 'sources' || p === 'history' ? p : 'console';
    return { panel, sessionId: m[1]!, view: 'sessions' };
  }
  const v = VIEW_RE.exec(hash)?.[1] ?? '';
  const view = SESSION_VIEWS.find((x) => x === v) ?? RENAMED[v] ?? 'sessions';
  return { panel: 'sessions', sessionId: null, view };
}

export function hrefFor(route: Route): string {
  if (route.panel === 'sessions' || !route.sessionId) return `#/${route.view}`;
  return `#/sessions/session-${route.sessionId}/${route.panel}`;
}

export function navigate(route: Omit<Route, 'view'> & { view?: SessionView }): void {
  location.hash = hrefFor({ view: 'sessions', ...route });
}

/** Switch which face of the sessions page is showing. */
export function navigateToView(view: SessionView): void {
  location.hash = `#/${view}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
