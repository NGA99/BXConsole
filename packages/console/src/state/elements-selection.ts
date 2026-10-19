/** The node selected in the Elements tab; also set by the Screen pane's inspect click. */
import { create } from 'zustand';

interface ElementsSelection {
  sessionId: string | null;
  id: number | null;
  select(sessionId: string, id: number | null): void;
}

export const useElementsSelection = create<ElementsSelection>((set) => ({
  sessionId: null,
  id: null,
  select: (sessionId, id) => set({ sessionId, id }),
}));
