/**
 * Session identity.
 *
 * A session is a debugging run, not a window. The id lives in sessionStorage,
 * which the browser COPIES into any window opened with window.open, so a page
 * that opens another window keeps the same session and the console shows the
 * windows as tabs inside it.
 *
 * The tab id identifies one window within that session. It also lives in
 * sessionStorage so a reload keeps it, which means a freshly opened window
 * inherits its opener's copy — so on install we check the opener and mint a
 * new one when the ids collide.
 */
import type { SessionHello } from '@bxconsole/protocol';
import { getHandle, storeKey } from './mark';
import type { AgentConfig } from './config';

/*
 * Read at the moment they are used, not when this module loads.
 *
 * As constants they were evaluated during import — before boot had a chance
 * to call setMark() — so a run that set its own mark still wrote the default
 * one into sessionStorage. Half the traces neutral and half not is worse than
 * either, and nothing would have said so.
 */
const sessionKey = () => storeKey('session');
const tabKey = () => storeKey('tab');

export interface LocalSession {
  sessionId: string;
  startedAt: number;
}

export interface LocalTab {
  tabId: string;
  openedBy?: string;
  startedAt: number;
}

/** Same shape the relay accepts; anything else is ignored rather than sent. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function getOrCreateSession(config: AgentConfig): LocalSession {
  const forced = config.sessionId && ID_RE.test(config.sessionId) ? config.sessionId : null;
  if (forced) {
    const pinned: LocalSession = { sessionId: forced, startedAt: Date.now() };
    writeJson(sessionKey(), pinned);
    return pinned;
  }
  const stored = readJson<LocalSession>(sessionKey());
  if (stored?.sessionId) return stored;
  const fresh: LocalSession = { sessionId: generateId(), startedAt: Date.now() };
  writeJson(sessionKey(), fresh);
  return fresh;
}

/**
 * The window's own id. A window opened by another inherits a copy of its
 * sessionStorage, so a stored id that matches the opener's live id belongs to
 * the opener, not to us: mint a fresh one and remember who opened us.
 */
export function getOrCreateTab(config: AgentConfig): LocalTab {
  const openerTab = openerTabId();
  const stored = readJson<LocalTab>(tabKey());
  const inherited = !!stored && !!openerTab && stored.tabId === openerTab;
  if (config.tabId && ID_RE.test(config.tabId)) {
    const pinned: LocalTab = { tabId: config.tabId, startedAt: Date.now(), ...(openerTab ? { openedBy: openerTab } : {}) };
    writeJson(tabKey(), pinned);
    return pinned;
  }
  if (stored?.tabId && !inherited) return stored;
  const fresh: LocalTab = { tabId: generateId(), startedAt: Date.now(), ...(openerTab ? { openedBy: openerTab } : {}) };
  writeJson(tabKey(), fresh);
  return fresh;
}

/** Take the window id the relay settled on, and remember it across reloads. */
export function adoptTabId(tab: LocalTab, tabId: string): void {
  tab.tabId = tabId;
  writeJson(tabKey(), tab);
}

/** The opener's live tab id, when the opener is same-origin and still has an agent. */
function openerTabId(): string | undefined {
  try {
    const op = window.opener as Window | null;
    return op && !op.closed ? getHandle(op)?.tabId : undefined;
  } catch {
    return undefined; // cross-origin opener
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // sessionStorage can throw in sandboxed iframes
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function buildHello(session: LocalSession, tab: LocalTab, config: AgentConfig): SessionHello {
  return {
    sessionId: session.sessionId,
    tabId: tab.tabId,
    tabStartedAt: tab.startedAt,
    ...(tab.openedBy ? { openedBy: tab.openedBy } : {}),
    name: config.name,
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    startedAt: session.startedAt,
    collect: config.collect,
  };
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}
