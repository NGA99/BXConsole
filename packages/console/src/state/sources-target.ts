/** "Go to source": a location link anywhere in the UI sets this and opens the Sources tab. */
import { create } from 'zustand';
import { navigate } from '../app/router';

export interface SourceTarget {
  /** which session asked; a panel for another session must ignore it */
  sessionId: string;
  url: string;
  line?: number;
  col?: number;
  /** bumps on every request so the same location can be re-opened */
  nonce: number;
}

interface SourcesTargetStore {
  target: SourceTarget | null;
  set(t: Omit<SourceTarget, 'nonce'>): void;
}

export const useSourcesTarget = create<SourcesTargetStore>((set) => ({
  target: null,
  set: (t) => set((s) => ({ target: { ...t, nonce: (s.target?.nonce ?? 0) + 1 } })),
}));

export function openSource(sessionId: string, url: string, line?: number, col?: number): void {
  // The session goes in: the Sources panel remounts per session, and without it
  // switching sessions would reopen the file you targeted in the previous one.
  useSourcesTarget.getState().set({ sessionId, url, ...(line ? { line } : {}), ...(col ? { col } : {}) });
  navigate({ panel: 'sources', sessionId });
}
