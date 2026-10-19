/** One context menu for the whole app: any component can open it. Rendered once by the Shell. */
import { create } from 'zustand';
import type { MenuItem, MenuState } from './ContextMenu';

interface MenuStore {
  menu: MenuState | null;
  open(x: number, y: number, items: MenuItem[]): void;
  close(): void;
}

export const useMenuStore = create<MenuStore>((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null }),
}));

export function openContextMenu(x: number, y: number, items: MenuItem[]): void {
  useMenuStore.getState().open(x, y, items);
}
