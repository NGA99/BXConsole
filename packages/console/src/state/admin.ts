/**
 * The administrator's view: every account, and every project with its owner.
 *
 * Only an administrator is sent this, and only while the screen asks for it.
 * The projects arrive as summaries without their agent keys — reassigning a
 * project is an administrator's job, reading one is not, and a key writes
 * into whatever engagement it belongs to.
 */
import { create } from 'zustand';
import type { AccountSummary, ProjectSummary } from '@bxconsole/protocol';

interface AdminState {
  accounts: AccountSummary[];
  projects: ProjectSummary[];
  /** Nothing has arrived yet, so the screen says "loading" and not "none". */
  loaded: boolean;
  /**
   * What the relay refused and why.
   *
   * Shown as it came. These are the one place the relay explains itself —
   * everywhere else a refusal would confirm something exists that the asker
   * cannot see — so dropping the message here would turn a clear "that name
   * is taken" into a button that does nothing.
   */
  error: string | null;
  set(accounts: AccountSummary[], projects: ProjectSummary[]): void;
  fail(message: string): void;
  clearError(): void;
}

export const useAdminStore = create<AdminState>((set) => ({
  accounts: [],
  projects: [],
  loaded: false,
  error: null,
  set: (accounts, projects) => set({ accounts, projects, loaded: true, error: null }),
  fail: (message) => set({ error: message }),
  clearError: () => set({ error: null }),
}));
