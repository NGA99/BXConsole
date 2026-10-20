/**
 * Who this console is signed in as.
 *
 * The console used to have no idea, because with one operator there was
 * nothing to know. It needs it now to decide what to draw: an administrator's
 * screen that only an administrator sees, and a project's own controls only
 * for the account that owns it.
 *
 * Drawn from, never trusted. Every one of these decisions is checked again on
 * the relay, where the socket's account is the one it was signed in with
 * rather than one a page claimed. What this buys is a console that shows what
 * works, instead of one where half the buttons fail.
 */
import { create } from 'zustand';
import type { AccountSummary } from '@bxconsole/protocol';

interface WhoamiState {
  /** Null until the relay says, which is the first thing it says. */
  account: AccountSummary | null;
  set(account: AccountSummary): void;
  clear(): void;
}

export const useWhoamiStore = create<WhoamiState>((set) => ({
  account: null,
  set: (account) => set({ account }),
  // On a dropped socket: the next one says who it is again, and until then
  // nothing claims to know. A stale account would keep an admin screen drawn
  // for a console that may come back as somebody else.
  clear: () => set({ account: null }),
}));

export function useAccount(): AccountSummary | null {
  return useWhoamiStore((s) => s.account);
}

export function useIsAdmin(): boolean {
  return useWhoamiStore((s) => s.account?.role === 'admin');
}
