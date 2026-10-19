export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

/**
 * One browser window inside a session. A session is a debugging run, not a
 * window: when the page opens another window it inherits the session id
 * (window.open copies sessionStorage), so the whole A -> B -> C flow lands in
 * one session and the console shows the windows as tabs within it.
 */
export interface SessionTab {
  tabId: string;
  url: string;
  title: string;
  viewport: Viewport;
  /** tabId of the window that opened this one, when the opener was reachable */
  openedBy?: string;
  startedAt: number;
  lastSeenAt: number;
  connected: boolean;
}

/** Everything the console needs to show a session in the Sessions tab. */
export interface SessionMeta {
  sessionId: string;
  /** From `data-name` on the agent script tag, or null. */
  name: string | null;
  /** The most recently active tab's url/title, so the session row reads sensibly. */
  url: string;
  title: string;
  userAgent: string;
  viewport: Viewport;
  startedAt: number;
  lastSeenAt: number;
  connected: boolean;
  /**
   * When the run was moved to the trash, if it was. A trashed run keeps its
   * recording on disk and is listed only in the Trash view, so deleting is a
   * second, deliberate step; any new activity brings it back.
   */
  trashedAt?: number;
  /**
   * Fetch and keep the code the page loads, as it loads it, rather than
   * waiting for someone to open the file. Absent on recordings made before
   * the option existed, which the relay reads as on.
   */
  collect?: boolean;
  /** Every window seen in this session, live or gone. Oldest first. */
  tabs: SessionTab[];
}

/** What the agent sends on hello. The server fills in the rest. */
export type SessionHello = Omit<SessionMeta, 'lastSeenAt' | 'connected' | 'tabs'> & {
  tabId: string;
  /** when this window first got an agent, as opposed to when the session began */
  tabStartedAt: number;
  openedBy?: string;
};
