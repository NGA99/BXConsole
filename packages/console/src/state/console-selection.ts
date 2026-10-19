/** "Reveal in Console": a console entry (by seq) to scroll to and flash. */
import { create } from 'zustand';
import { navigate } from '../app/router';

interface ConsoleSelection {
  sessionId: string | null;
  seq: number | null;
  nonce: number;
  set(sessionId: string, seq: number): void;
  clear(): void;
}

export const useConsoleSelection = create<ConsoleSelection>((set) => ({
  sessionId: null,
  seq: null,
  nonce: 0,
  set: (sessionId, seq) => set((s) => ({ sessionId, seq, nonce: s.nonce + 1 })),
  clear: () => set({ sessionId: null, seq: null }),
}));

export function revealConsole(sessionId: string, seq: number): void {
  useConsoleSelection.getState().set(sessionId, seq);
  navigate({ panel: 'console', sessionId });
}
