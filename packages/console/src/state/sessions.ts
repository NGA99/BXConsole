/** Sessions tab data: every session the relay knows about, live or recorded. */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { SessionMeta } from '@bxconsole/protocol';

interface SessionsState {
  relayConnected: boolean;
  byId: Record<string, SessionMeta>;
  order: string[];
  setConnection(up: boolean): void;
  setAll(list: SessionMeta[]): void;
  upsert(meta: SessionMeta): void;
  remove(sessionId: string): void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  relayConnected: false,
  byId: {},
  order: [],
  setConnection: (up) => set({ relayConnected: up }),
  setAll: (list) =>
    set({
      byId: Object.fromEntries(list.map((m) => [m.sessionId, m])),
      order: list.map((m) => m.sessionId),
    }),
  upsert: (meta) =>
    set((s) => ({
      byId: { ...s.byId, [meta.sessionId]: meta },
      order: s.order.includes(meta.sessionId) ? s.order : [meta.sessionId, ...s.order],
    })),
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
