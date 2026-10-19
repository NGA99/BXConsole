/**
 * Which window of a session the console is pointed at.
 *
 * A session can hold several windows (the page opened another with
 * window.open). Commands go to this one, and Console/Network show its events;
 * History deliberately ignores it and shows the whole run.
 */
import { create } from 'zustand';

interface ActiveTabState {
  bySession: Record<string, string | null>;
  set(sessionId: string, tabId: string | null): void;
}

export const useActiveTabStore = create<ActiveTabState>((set) => ({
  bySession: {},
  set: (sessionId, tabId) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: tabId } })),
}));

/** Non-reactive read, for the transport. */
export function activeTabOf(sessionId: string): string | undefined {
  return useActiveTabStore.getState().bySession[sessionId] ?? undefined;
}

export function useActiveTab(sessionId: string): string | null {
  return useActiveTabStore((s) => s.bySession[sessionId] ?? null);
}

export function setActiveTab(sessionId: string, tabId: string | null): void {
  useActiveTabStore.getState().set(sessionId, tabId);
}
