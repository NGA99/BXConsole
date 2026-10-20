/** Sessions tab data: every session the relay knows about, live or recorded. */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { SessionMeta } from '@bxconsole/protocol';

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
  setAll: (list, keep) =>
    set({
      byId: Object.fromEntries(list.map((m) => [m.sessionId, m])),
      order: list.map((m) => m.sessionId),
      retentionDays: keep?.retentionDays ?? 0,
      trashPurgeDays: keep?.trashPurgeDays ?? 0,
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
