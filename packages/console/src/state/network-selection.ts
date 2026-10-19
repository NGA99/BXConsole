/** "Reveal in Network": a request to select when the Network tab shows. */
import { create } from 'zustand';
import { navigate } from '../app/router';

interface NetworkSelection {
  sessionId: string | null;
  requestId: string | null;
  nonce: number;
  set(sessionId: string, requestId: string): void;
  clear(): void;
}

export const useNetworkSelection = create<NetworkSelection>((set) => ({
  sessionId: null,
  requestId: null,
  nonce: 0,
  set: (sessionId, requestId) => set((s) => ({ sessionId, requestId, nonce: s.nonce + 1 })),
  clear: () => set({ sessionId: null, requestId: null }),
}));

export function revealRequest(sessionId: string, requestId: string): void {
  useNetworkSelection.getState().set(sessionId, requestId);
  navigate({ panel: 'network', sessionId });
}
