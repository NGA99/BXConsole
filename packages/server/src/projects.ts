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
  AGENT_KEY_BYTES,
  PROJECTS_FILE,
  PROJECT_NAME_MAX,
  isValidAgentKey,
  isValidProjectId,
  mayRead,
  type Project,
  type SessionMeta,
} from '@bxconsole/protocol';

export function newProjectId(): string {
  return randomBytes(6).toString('hex');
}

export function newAgentKey(): string {
  return randomBytes(AGENT_KEY_BYTES).toString('hex');
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
    const kept = list.filter(isStoredProject);
    if (kept.length !== list.length) {
      this.warn(`${PROJECTS_FILE}: ignored ${list.length - kept.length} malformed entr${list.length - kept.length === 1 ? 'y' : 'ies'}`);
    }
    /*
     * A file that parsed, held projects, and left us with none of them.
     *
     * That is a file to fix, not an empty relay — and the two look identical
     * from here, which is the whole danger: an empty list is what a fresh
     * install looks like, so the migration would make a home project and
     * write it over the one that says who owns what. It has already nearly
     * happened once, from making a newly added field required and so turning
     * every existing row into a malformed one.
     */
    if (list.length > 0 && kept.length === 0) {
      this.broken = true;
      this.warn(`${PROJECTS_FILE}: none of its ${list.length} project(s) could be read`);
      this.warn(`${PROJECTS_FILE} holds who owns which recordings, so nothing is written and no sessions are listed until it is fixed.`);
      return;
    }
    /*
     * Give a key to any project written before there were keys.
     *
     * Drawn here rather than derived, like an account id: a key that could be
     * worked out from the project would be a key anyone could work out. The
     * project keeps its id and its owner, so nothing moves — payloads simply
     * could not have carried a key that did not exist yet, and ACCEPT_KEYLESS
     * is what covers the ones already out there.
     */
    const keyless = kept.filter((p) => p.agentKey === undefined);
    this.projects = kept.map((p) => (p.agentKey === undefined ? { ...p, agentKey: newAgentKey() } : (p as Project)));

    const home = typeof held.home === 'string' ? held.home : null;
    this.home = home && this.projects.some((p) => p.id === home) ? home : (this.projects[0]?.id ?? null);

    if (keyless.length) {
      await this.save();
      this.warn(`${PROJECTS_FILE}: drew an agent key for ${keyless.map((p) => `"${p.name}"`).join(', ')}`);
    }
  }

  /**
   * One write at a time.
   *
   * Two consoles making a project at the same moment both got as far as the
   * rename, and the second failed with ENOENT: they shared a temporary name,
   * so the first rename took it away from under the second. The handler that
   * threw stopped before telling anybody, so a project existed that the
   * console was never told about — and with a different interleaving the
   * renames could have crossed the other way and lost a write outright.
   */
  private writing: Promise<void> = Promise.resolve();

  private async save(): Promise<void> {
    const next = this.writing.then(() => this.writeNow(), () => this.writeNow());
    this.writing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async writeNow(): Promise<void> {
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
   * The project a payload's key names, or null.
   *
   * Shape first, so a key that is not one never reaches the list; then an
   * exact match. A trashed project still answers: a payload from an
   * engagement someone has just tidied away still has pages open, and
   * dropping those runs would lose the tail of the engagement rather than
   * tidy it. Taking it out of the trash is a click; the recording cannot be
   * taken again.
   */
  byAgentKey(key: string): Project | null {
    if (this.broken || !isValidAgentKey(key)) return null;
    return this.projects.find((p) => p.agentKey === key) ?? null;
  }

  /** Draw this project a new key, so payloads carrying the old one stop. */
  async rotateKey(projectId: string): Promise<Project | null> {
    return this.update(projectId, { agentKey: newAgentKey() });
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
      agentKey: newAgentKey(),
      createdAt: Date.now(),
    };
    this.projects.push(project);
    if (opts.home || this.home === null) this.home = project.id;
    await this.save();
    return project;
  }

  /** Change some of a project's fields, or null when there is no such project. */
  async update(projectId: string, change: Partial<Pick<Project, 'name' | 'owner' | 'sharedWith' | 'agentKey'>>): Promise<Project | null> {
    const at = this.projects.findIndex((p) => p.id === projectId);
    if (at < 0) return null;
    const next: Project = { ...this.projects[at]!, ...change };
    if (change.name !== undefined) next.name = cleanName(change.name);
    this.projects[at] = next;
    await this.save();
    return next;
  }

  async setTrashed(projectId: string, trashed: boolean): Promise<Project | null> {
    /*
     * The home project cannot be trashed, for the same reason it cannot be
     * deleted and one more.
     *
     * A payload with no key lands in it, and a key names it whether or not it
     * is in the trash — a page from an engagement someone has just tidied
     * away still has windows open, and dropping those runs would lose the
     * tail of the engagement rather than tidy it. So a trashed home project
     * would go on collecting recordings while sitting in the trash. And the
     * purge could not clear it either, because deleting it is refused: it
     * would sit there, filling up, for good.
     */
    if (trashed && projectId === this.home) return null;
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

/**
 * A project as the file may hold it: everything but the key, which a file
 * written before keys existed does not have. `load` fills those in.
 */
type StoredProject = Omit<Project, 'agentKey'> & { agentKey?: string };

function isStoredProject(value: unknown): value is StoredProject {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<Project>;
  return (
    typeof p.id === 'string' &&
    isValidProjectId(p.id) &&
    typeof p.name === 'string' &&
    typeof p.owner === 'string' &&
    Array.isArray(p.sharedWith) &&
    p.sharedWith.every((s) => typeof s === 'string') &&
    // agentKey is not required here: a file written before keys existed has
    // none, and calling those rows malformed would drop every project on the
    // relay — see the `keyless` handling in load().
    (p.agentKey === undefined || (typeof p.agentKey === 'string' && isValidAgentKey(p.agentKey))) &&
    typeof p.createdAt === 'number' &&
    (p.trashedAt === undefined || typeof p.trashedAt === 'number')
  );
}
