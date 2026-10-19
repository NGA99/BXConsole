/** Chrome's "select an element" toggle: lives in the tab strip, acts on the Screen mirror, turns off after one pick. */
import { create } from 'zustand';

interface InspectMode {
  on: boolean;
  set(on: boolean): void;
  toggle(): void;
}

export const useInspectMode = create<InspectMode>((set) => ({
  on: false,
  set: (on) => set({ on }),
  toggle: () => set((s) => ({ on: !s.on })),
}));
