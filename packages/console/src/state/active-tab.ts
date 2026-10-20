/**
 * Which window of a session the console is pointed at.
 *
 * A session can hold several windows (the page opened another with
 * window.open). Commands go to this one, and Console/Network show its events;
 * History deliberately ignores it and shows the whole run.
 *
 * The pick outlives a reload, which is the only reason this is not a plain
 * store. Without that it was derived again from nothing every time the page
 * came back, and the only thing left to derive it from is which windows are
 * still live — so a run whose later windows had closed reopened on its first
 * one, and the console output being read went with it. Remembering the pick
 * is what makes leaving and coming back land where you left.
 */
import { create } from 'zustand';

const KEY = 'bxconsole.activeTab';
/** Enough runs to come back to; the oldest picks fall off the end. */
const KEEP = 100;

type Picks = Record<string, string | null>;

function load(): Picks {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Picks = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' || v === null) out[k] = v;
    }
    return out;
  } catch {
    return {}; // a private window still works, it just forgets
  }
}

function save(picks: Picks): void {
  try {
    // Objects keep insertion order for these keys, so the tail is the newest.
    const entries = Object.entries(picks);
    const kept = entries.length > KEEP ? entries.slice(entries.length - KEEP) : entries;
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* out of quota, or no storage at all: the pick is still good for this page */
  }
}

interface ActiveTabState {
  bySession: Picks;
  set(sessionId: string, tabId: string | null): void;
}

export const useActiveTabStore = create<ActiveTabState>((set) => ({
  bySession: load(),
  set: (sessionId, tabId) =>
    set((s) => {
      // Re-inserted rather than updated in place, so a session picked again is
      // the newest and survives the trim.
      const { [sessionId]: _old, ...rest } = s.bySession;
      const bySession = { ...rest, [sessionId]: tabId };
      save(bySession);
      return { bySession };
    }),
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
