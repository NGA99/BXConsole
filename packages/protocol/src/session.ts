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
  /**
   * The token every trace the agent left in the page is named from, so the
   * console can say the handle out loud: `__wv.mark('x')` for a default run,
   * and whatever `data-mark` chose for an engagement that set one.
   *
   * It is here because the console was telling operators to call
   * `window.__bxconsole.mark(...)`, which has never existed under that name.
   * Absent on recordings made before this was sent, and on those the console
   * falls back to describing the handle rather than naming it wrongly.
   */
  mark?: string;
  /**
   * The project this run is in.
   *
   * Optional because every recording made before projects existed has none,
   * and those still have to open — a relay that hid them would look like it
   * had lost them. The relay reads a run with no project as being in the
   * home project, which is where the migration put the ones it found.
   *
   * Not from the agent. The page says which session it is, because only the
   * page knows that; which project the run belongs to is the relay's to
   * decide, or a payload could put its recording in somebody else's
   * engagement by naming it.
   */
  projectId?: string;
  /** Every window seen in this session, live or gone. Oldest first. */
  tabs: SessionTab[];
}

/** What the agent sends on hello. The server fills in the rest. */
export type SessionHello = Omit<SessionMeta, 'lastSeenAt' | 'connected' | 'tabs' | 'projectId'> & {
  tabId: string;
  /** when this window first got an agent, as opposed to when the session began */
  tabStartedAt: number;
  openedBy?: string;
};
