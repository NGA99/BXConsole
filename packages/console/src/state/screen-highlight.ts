/**
 * Console -> Screen link: hovering a DOM node logged in the console asks the
 * agent for its screen node id and sets it here; the Screen pane outlines it.
 */
import { create } from 'zustand';

interface ScreenHighlight {
  screenId: number | null;
  label: string;
  set(screenId: number | null, label?: string): void;
}

export const useScreenHighlight = create<ScreenHighlight>((set) => ({
  screenId: null,
  label: '',
  set: (screenId, label = '') => set({ screenId, label }),
}));
