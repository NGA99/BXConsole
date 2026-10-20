/**
 * The project list, and the one-time move of existing recordings into it.
 *
 * Small enough to hold in memory and rewrite whole: a relay has tens of
 * projects, not thousands, and a list that is read on every console message
 * wants to be a field rather than a file read. Every change writes the file
 * back before it returns, so a relay that is killed between two of them
 * loses nothing that was reported as done.
 *
 * Unlike `.passwd`, this file is not hand-edited and is not watched for
 * changes: it is written here and read here.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  PROJECTS_FILE,
  PROJECT_NAME_MAX,
  isValidProjectId,
  mayRead,
  type Project,
  type SessionMeta,
} from '@bxconsole/protocol';

export function newProjectId(): string {
  return randomBytes(6).toString('hex');
}

/** The name the migration gives the project it puts everything in. */
export const HOME_PROJECT_NAME = 'First project';

export class ProjectStore {
  private projects: Project[] = [];
  /** Where a run with no project of its own is read as being. */
  private home: string | null = null;
  /**
   * The file is there and could not be read.
   *
   * Kept apart from "there are no projects yet", which looks identical from
   * the outside and means the opposite. An empty list invites the migration
   * to make a home project and write it down — over the file that holds who
   * owns what, reassigning every recording on the relay to whoever the
   * migration was told to give them to. So a file that did not parse is not
   * an empty list: nothing is written, nothing is migrated, and until it is
   * fixed no console is shown anything.
   */
  private broken = false;

  constructor(
    private readonly rootDir: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  private get file(): string {
    return path.join(this.rootDir, PROJECTS_FILE);
  }

  /** Read the file, or nothing when there is none yet. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      /*
       * Not fatal, and not overwritten either.
       *
       * Throwing here would stop the relay from booting, and a relay that
       * will not boot drops every live agent — the recordings those pages are
       * producing cannot be restarted. So it comes up with no projects, says
       * so, and the operator can put the file back; writing a fresh list over
       * a file we failed to parse is the one thing that would lose it.
       */
      this.broken = true;
      this.warn(`${PROJECTS_FILE} did not parse (${(err as Error).message})`);
      this.warn(`${PROJECTS_FILE} holds who owns which recordings, so nothing is written and no sessions are listed until it is fixed.`);
      this.warn('The relay is still recording; put the file back and restart when it suits you.');
      return;
    }
    const held = parsed as { projects?: unknown; home?: unknown };
    const list = Array.isArray(held.projects) ? held.projects : [];
    this.projects = list.filter(isProject);
    if (this.projects.length !== list.length) {
      this.warn(`${PROJECTS_FILE}: ignored ${list.length - this.projects.length} malformed entr${list.length - this.projects.length === 1 ? 'y' : 'ies'}`);
    }
    const home = typeof held.home === 'string' ? held.home : null;
    this.home = home && this.projects.some((p) => p.id === home) ? home : (this.projects[0]?.id ?? null);
  }

  private async save(): Promise<void> {
    // Never over a file we could not read.
    if (this.broken) throw new Error(`refusing to write ${PROJECTS_FILE}: it did not parse at startup`);
    const body = JSON.stringify({ home: this.home, projects: this.projects }, null, 2);
    // Written and renamed, so a kill mid-write leaves the old list rather
    // than half of the new one — this file says who owns what.
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  all(): readonly Project[] {
    return this.projects;
  }

  get(projectId: string): Project | undefined {
    return this.projects.find((p) => p.id === projectId);
  }

  /**
   * The project a new run goes into, and what a run with no project means.
   *
   * One for the whole relay until a payload can say which project it is for —
   * the key in the injected script, which comes next. Until then every agent
   * that connects is in the same engagement, which is what a relay with one
   * operator already was.
   */
  homeId(): string | null {
    return this.home;
  }

  /** Whether the list could not be read, so nothing should be shown. */
  get isBroken(): boolean {
    return this.broken;
  }

  /**
   * Whether this account may read a run that is in this project.
   *
   * The one rule, because there are two ways to ask for a recording and they
   * have to agree: over the console socket, where the relay checks every
   * message that names a session, and over HTTP, where `/body/` and
   * `/asset/` hand back the bytes of one run's traffic. Those two were
   * answering different questions — the socket asked which account, and the
   * endpoints only asked whether anybody was signed in.
   *
   * `undefined` for the project means a recording made before projects
   * existed, or one the migration did not reach, and it is read as being in
   * the home project.
   */
  maySeeSessionIn(projectId: string | undefined, accountId: string | undefined): boolean {
    if (this.broken) return false;
    const project = this.get(projectId ?? this.home ?? '');
    return project !== undefined && mayRead(project, accountId);
  }

  /** The projects this account may read, newest first. */
  visibleTo(accountId: string | undefined): Project[] {
    if (this.broken) return [];
    return this.projects.filter((p) => mayRead(p, accountId)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async create(name: string, owner: string, opts: { home?: boolean } = {}): Promise<Project> {
    const project: Project = {
      id: newProjectId(),
      name: cleanName(name),
      owner,
      sharedWith: [],
      createdAt: Date.now(),
    };
    this.projects.push(project);
    if (opts.home || this.home === null) this.home = project.id;
    await this.save();
    return project;
  }

  /** Change some of a project's fields, or null when there is no such project. */
  async update(projectId: string, change: Partial<Pick<Project, 'name' | 'owner' | 'sharedWith'>>): Promise<Project | null> {
    const at = this.projects.findIndex((p) => p.id === projectId);
    if (at < 0) return null;
    const next: Project = { ...this.projects[at]!, ...change };
    if (change.name !== undefined) next.name = cleanName(change.name);
    this.projects[at] = next;
    await this.save();
    return next;
  }

  async setTrashed(projectId: string, trashed: boolean): Promise<Project | null> {
    const at = this.projects.findIndex((p) => p.id === projectId);
    if (at < 0) return null;
    const { trashedAt: _was, ...kept } = this.projects[at]!;
    const next: Project = trashed ? { ...kept, trashedAt: Date.now() } : kept;
    this.projects[at] = next;
    await this.save();
    return next;
  }

  /**
   * Take a project off the list.
   *
   * The recordings in it are deleted by the caller, which owns the session
   * registry; this only stops it being a project. Refused for the home
   * project, because every run with no project of its own is read as being in
   * it and new runs land there — deleting it would make the next agent to
   * connect have nowhere to go.
   */
  /**
   * Whether `remove` would go through, asked before anything is deleted.
   *
   * Deleting a project means deleting the recordings in it, and those go
   * first so that a relay killed halfway through leaves a project with fewer
   * runs rather than runs belonging to a project that is not there. Which
   * means the refusal has to be available before the first recording goes:
   * finding out afterwards that this is the home project leaves it emptied
   * and still standing.
   */
  canRemove(projectId: string): boolean {
    return !this.broken && projectId !== this.home && this.projects.some((p) => p.id === projectId);
  }

  async remove(projectId: string): Promise<boolean> {
    if (projectId === this.home) return false;
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== projectId);
    if (this.projects.length === before) return false;
    await this.save();
    return true;
  }

  /**
   * Put the recordings that are already here into a project.
   *
   * Runs once, on a relay that has sessions and no projects — which is every
   * relay that was installed before this. It makes one project, owned by the
   * account given, and stamps every session with it. Idempotent by its own
   * condition: once there is a project list there is nothing to migrate, so
   * it does nothing on every boot after the first.
   *
   * It is also the reason `projectId` is optional on a session. A relay
   * killed partway through this has stamped some of its sessions and not
   * others, and the ones it did not reach still have to open — they are read
   * as being in the home project, which is exactly where this was putting
   * them.
   */
  async migrateInto(owner: string, sessions: readonly SessionMeta[], stamp: (meta: SessionMeta) => Promise<void>): Promise<Project | null> {
    if (this.broken || this.projects.length > 0) return null;
    const project = await this.create(HOME_PROJECT_NAME, owner, { home: true });
    let done = 0;
    for (const meta of sessions) {
      if (meta.projectId !== undefined) continue;
      meta.projectId = project.id;
      try {
        await stamp(meta);
        done++;
      } catch (err) {
        // The recording is still readable — it just has no project written
        // down, and is read as being in the home one. Worth saying, not
        // worth stopping for.
        this.warn(`could not write the project into session-${meta.sessionId} (${(err as Error).message})`);
      }
    }
    this.warn(`made "${project.name}" and put ${done} existing session(s) in it`);
    return project;
  }
}

/** Trim, collapse runs of whitespace, cut to length, and never return empty. */
function cleanName(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').trim().slice(0, PROJECT_NAME_MAX);
  return cleaned || 'Untitled';
}

function isProject(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<Project>;
  return (
    typeof p.id === 'string' &&
    isValidProjectId(p.id) &&
    typeof p.name === 'string' &&
    typeof p.owner === 'string' &&
    Array.isArray(p.sharedWith) &&
    p.sharedWith.every((s) => typeof s === 'string') &&
    typeof p.createdAt === 'number' &&
    (p.trashedAt === undefined || typeof p.trashedAt === 'number')
  );
}
