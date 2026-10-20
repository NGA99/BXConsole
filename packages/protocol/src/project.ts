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

/** Longer than this is a paragraph, not a name. */
export const PROJECT_NAME_MAX = 80;

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
