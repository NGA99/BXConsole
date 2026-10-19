/** The session the right-hand panels are showing, for components that need it without prop drilling. */
import { createContext, useContext } from 'react';

export const SessionContext = createContext<string | null>(null);

export function useSessionId(): string | null {
  return useContext(SessionContext);
}
