/** Sessions tab data: every session the relay knows about, live or recorded. */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { SessionMeta, SessionTab, Viewport } from '@bxconsole/protocol';

/*
 * These fields are typed as strings and numbers, and at runtime they are
 * whatever the debugged page put on the socket. A `page.navigated` carrying
 * `url: null` reaches meta.json and then this list, and the panels hand these
 * values to `new URL()`, `.split()` and `.slice()`: one wrong type threw
 * during render, and because the Sessions list is the console's front page,
 * that blanked the whole UI for *every* session until the file on disk was
 * edited by hand. The types cannot be trusted at this boundary, so the values
 * are coerced once, here, where they arrive.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function viewportOf(v: unknown): Viewport {
  const o = (v ?? {}) as Record<string, unknown>;
  return { width: num(o.width), height: num(o.height), dpr: num(o.dpr) || 1 };
}

function tabOf(t: unknown): SessionTab {
  const o = (t ?? {}) as Record<string, unknown>;
  return {
    ...(o as unknown as SessionTab),
    tabId: str(o.tabId),
    url: str(o.url),
    title: str(o.title),
    viewport: viewportOf(o.viewport),
    startedAt: num(o.startedAt),
    lastSeenAt: num(o.lastSeenAt),
    connected: !!o.connected,
  };
}

/** One session's metadata with its strings and numbers made real. */
export function normalizeMeta(meta: SessionMeta): SessionMeta {
  const o = meta as unknown as Record<string, unknown>;
  return {
    ...meta,
    sessionId: str(o.sessionId),
    // `name` is nullable by design: it is absent unless the script tag set one.
    name: typeof o.name === 'string' ? o.name : null,
    url: str(o.url),
    title: str(o.title),
    userAgent: str(o.userAgent),
    viewport: viewportOf(o.viewport),
    startedAt: num(o.startedAt),
    lastSeenAt: num(o.lastSeenAt),
    connected: !!o.connected,
    tabs: Array.isArray(o.tabs) ? o.tabs.map(tabOf) : [],
  };
}

interface SessionsState {
  relayConnected: boolean;
  byId: Record<string, SessionMeta>;
  order: string[];
  /**
   * What this relay does with recordings over time, as it reports it.
   *
   * Kept rather than assumed so the console says what will happen here
   * rather than what the defaults say: `trashPurgeDays` is how long
   * something stays in the trash before it is deleted, and 0 means the trash
   * is only emptied by hand.
   */
  retentionDays: number;
  trashPurgeDays: number;
  setConnection(up: boolean): void;
  setAll(list: SessionMeta[], keep?: { retentionDays?: number; trashPurgeDays?: number }): void;
  upsert(meta: SessionMeta): void;
  remove(sessionId: string): void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  relayConnected: false,
  byId: {},
  order: [],
  retentionDays: 0,
  trashPurgeDays: 0,
  setConnection: (up) => set({ relayConnected: up }),
  setAll: (list, keep) => {
    // Normalized before anything indexes them: a sessionId that is not a
    // string must not become a key, and the panels read url/title straight.
    const metas = (Array.isArray(list) ? list : []).map(normalizeMeta);
    set({
      byId: Object.fromEntries(metas.map((m) => [m.sessionId, m])),
      order: metas.map((m) => m.sessionId),
      retentionDays: keep?.retentionDays ?? 0,
      trashPurgeDays: keep?.trashPurgeDays ?? 0,
    });
  },
  upsert: (raw) =>
    set((s) => {
      const meta = normalizeMeta(raw);
      return {
        byId: { ...s.byId, [meta.sessionId]: meta },
        order: s.order.includes(meta.sessionId) ? s.order : [meta.sessionId, ...s.order],
      };
    }),
  remove: (sessionId) =>
    set((s) => {
      const { [sessionId]: _dropped, ...rest } = s.byId;
      return { byId: rest, order: s.order.filter((id) => id !== sessionId) };
    }),
}));

export function useSessionList(): SessionMeta[] {
  // useShallow: the mapped array is new each call; compare elements, not identity.
  return useSessionsStore(useShallow((s) => s.order.map((id) => s.byId[id]!)));
}
