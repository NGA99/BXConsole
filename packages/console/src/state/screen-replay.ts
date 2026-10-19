/**
 * "Show the screen at this moment": a point in time the Screen panel should
 * rewind to, and where its playback currently stands.
 *
 * Same shape as revealRequest / revealConsole — History asks, the Screen panel
 * answers — with one addition: the panel publishes its playhead back, so the
 * History timeline can draw where the replay is.
 */
import { create } from 'zustand';
import { navigate } from '../app/router';

interface ScreenReplayState {
  /** what someone asked to see; `nonce` so asking for the same ts twice still lands */
  sessionId: string | null;
  ts: number | null;
  nonce: number;
  /** where the Screen panel's replay stands, null when it is live */
  playhead: { sessionId: string; ts: number; playing: boolean } | null;
  set(sessionId: string, ts: number): void;
  clear(): void;
  setPlayhead(playhead: { sessionId: string; ts: number; playing: boolean } | null): void;
}

export const useScreenReplay = create<ScreenReplayState>((set) => ({
  sessionId: null,
  ts: null,
  nonce: 0,
  playhead: null,
  set: (sessionId, ts) => set((s) => ({ sessionId, ts, nonce: s.nonce + 1 })),
  clear: () => set({ sessionId: null, ts: null }),
  setPlayhead: (playhead) => set({ playhead }),
}));

/**
 * Rewind the Screen mirror to `ts`. Stays on the current tab: the mirror is
 * docked beside it, so you can watch the moment next to the event list.
 * (Shell un-collapses the pane when it is hidden.)
 */
export function revealScreenAt(sessionId: string, ts: number): void {
  useScreenReplay.getState().set(sessionId, ts);
}

/** Same, but from somewhere without the Screen pane in view. */
export function openScreenAt(sessionId: string, ts: number, panel: 'history' | 'console' = 'history'): void {
  revealScreenAt(sessionId, ts);
  navigate({ panel, sessionId });
}
