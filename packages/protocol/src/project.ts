/**
 * Projects: the thing an account owns, and what sessions are divided by.
 *
 * A session is a run of one page; an engagement is many of them, and the
 * people on it are not the people on the next one. So the account is not what
 * a recording belongs to — a project is, and the account owns the project.
 * That extra level is what makes three things possible that a flat
 * account-to-session mapping cannot: handing work over without moving any
 * recordings, letting a second person in on one engagement without letting
 * them in on everything, and deleting an engagement as a unit.
 *
 * Projects are listed in `sessions/projects.json`; each session's `meta.json`
 * names the one it is in. Nothing is nested on disk. Nesting the directories
 * was the first plan and it buys nothing here: the project a path would be
 * built from is itself looked up from the session id, so a forgotten check
 * resolves the right project and reads it anyway. The isolation is in the
 * code either way, and keeping the layout flat means the migration into it is
 * a field added to a file rather than every recording moved.
 */

/** Where the project list lives, beside the sessions it divides. */
export const PROJECTS_FILE = 'projects.json';

/** Like a session id: it reaches a filename, and `..` must not. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_RE.test(projectId);
}

/**
 * The shape of an agent key.
 *
 * Where this earns its keep is reading the project file: a project whose key
 * is not this shape is a malformed row and is dropped, so a hand-written
 * `agentKey: "x"` cannot become a key anyone could guess. Checking a key
 * arriving from a page is only an early no — an unknown key matches nothing
 * either way — and it keeps a pathological one from being compared against
 * every project on the relay.
 */
const AGENT_KEY_RE = /^[a-f0-9]{32}$/;

export function isValidAgentKey(key: string): boolean {
  return AGENT_KEY_RE.test(key);
}

/** Sixteen bytes: too many to guess, short enough to paste into a snippet. */
export const AGENT_KEY_BYTES = 16;

/** Longer than this is a paragraph, not a name. */
export const PROJECT_NAME_MAX = 80;

/**
 * How long something stays in the trash before it is deleted for good.
 *
 * The trash is what makes deleting a two-step thing: the first step is
 * reversible and the second is not, and this is how long the first one
 * lasts. A week because that is long enough to notice a mistake and come
 * back from a weekend, and short enough that a relay does not quietly keep
 * engagement data nobody wants.
 *
 * The console is told the figure rather than assuming it, so that a relay
 * configured differently says what it will actually do.
 */
export const TRASH_PURGE_DAYS = 7;

/**
 * The shortest password either way in. Named here because there are two ways
 * in now — the CLI and the admin screen — and a screen that accepted eight
 * characters while the CLI demanded twelve would be a rule nobody could read.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** What the console is told about an account. Never the credential. */
export interface AccountSummary {
  readonly id: string;
  readonly user: string;
  readonly role: AccountRole;
}

/**
 * Named for what it is a role of, because `Role` is already taken in this
 * package by which end of a socket something is.
 */
export type AccountRole = 'admin' | 'member';

/**
 * A project as an administrator sees it, which is not as its owner does.
 *
 * Deliberately without the agent key. Reassigning a project is an
 * administrator's job and reading it is not — see mayRead — and the key is a
 * write capability for whatever engagement it belongs to: handing it over
 * would make "list the projects" a way to start recording into any of them.
 */
export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly sharedWith: readonly string[];
  readonly createdAt: number;
  readonly trashedAt?: number;
  /** How many recordings are in it, so deleting one says what it costs. */
  readonly sessions: number;
}

export interface Project {
  readonly id: string;
  name: string;
  /**
   * The account id that owns it — not the account name, which can change, and
   * not the credential, which changes with every password.
   */
  owner: string;
  /**
   * Other account ids that may read it.
   *
   * Empty everywhere for now and honoured everywhere already, so that sharing
   * is a screen to build rather than a rule to add: whatever puts an id in
   * here makes the project readable to that account the moment it does.
   */
  sharedWith: string[];
  /**
   * The token a payload carries to say which project its run belongs in.
   *
   * Not a secret from the page. It rides in the injected script, so a victim
   * who goes looking can read it — and that is survivable, because the key
   * only writes. It says where a recording goes; it does not open one. The
   * worst anyone can do with a key they found is fill that project with runs
   * of their own, which is a nuisance to be noticed and rotated, not a way
   * into anybody's data.
   *
   * It is long enough not to be guessed, because guessing one would be the
   * same nuisance without having to find a payload first.
   */
  agentKey: string;
  createdAt: number;
  /**
   * When it was moved to the trash. A trashed project keeps every recording
   * and is listed only in the Trash view; the purge deletes it a week later,
   * which is the only step that destroys anything.
   */
  trashedAt?: number;
}

/** Whether this account may read this project at all. */
export function mayRead(project: Project, accountId: string | undefined): boolean {
  if (accountId === undefined) return false;
  return project.owner === accountId || project.sharedWith.includes(accountId);
}

/**
 * Whether this account may change the project itself — rename, trash, delete.
 *
 * The owner, and nobody else. Being let in on a project is being let in on
 * its recordings, not on its existence: someone shared with cannot delete
 * the engagement they were invited to read. An administrator reassigns the
 * owner instead, which is a change to the file and not a quiet read.
 */
export function mayAdminister(project: Project, accountId: string | undefined): boolean {
  return accountId !== undefined && project.owner === accountId;
}
