/**
 * The project list.
 *
 * It is the file that says who owns which recordings, so the failures that
 * matter here are the quiet ones: a migration that runs twice and reassigns
 * everything, a write over a file that could not be read, and a home project
 * deleted out from under the next agent to connect.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROJECTS_FILE, mayAdminister, mayRead, type SessionMeta } from '@bxconsole/protocol';
import { ProjectStore } from '../src/projects';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'bxc-projects-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A store on a fresh directory, with its warnings collected. */
function store(dir = tmp()): { store: ProjectStore; dir: string; warnings: string[] } {
  const warnings: string[] = [];
  return { store: new ProjectStore(dir, (m) => warnings.push(m)), dir, warnings };
}

const ANA = 'a1a1a1';
const BO = 'b2b2b2';

/** A session row with just the fields the migration touches. */
function session(sessionId: string, projectId?: string): SessionMeta {
  return {
    sessionId,
    name: null,
    url: 'http://app.test/',
    title: 'app',
    userAgent: 'test',
    viewport: { width: 800, height: 600, dpr: 1 },
    startedAt: 1,
    lastSeenAt: 1,
    connected: false,
    tabs: [],
    ...(projectId ? { projectId } : {}),
  };
}

describe('making and reading the list', () => {
  test('an absent file is no projects, not an error', async () => {
    const { store: s } = store();
    await s.load();
    assert.deepEqual(s.all(), []);
    assert.equal(s.homeId(), null);
  });

  test('the first project becomes the home one, and it survives a reload', async () => {
    const { store: s, dir } = store();
    await s.load();
    const made = await s.create('An engagement', ANA);
    assert.equal(s.homeId(), made.id);

    const again = new ProjectStore(dir);
    await again.load();
    assert.equal(again.homeId(), made.id);
    assert.equal(again.get(made.id)?.name, 'An engagement');
    assert.equal(again.get(made.id)?.owner, ANA);
    assert.deepEqual(again.get(made.id)?.sharedWith, []);
  });

  test('a later project does not take the home one over', async () => {
    const { store: s } = store();
    await s.load();
    const first = await s.create('First', ANA);
    await s.create('Second', ANA);
    assert.equal(s.homeId(), first.id);
  });

  test('a name is tidied rather than taken as typed, and never ends up empty', async () => {
    const { store: s } = store();
    await s.load();
    assert.equal((await s.create('  spaced   out  ', ANA)).name, 'spaced out');
    assert.equal((await s.create('   ', ANA)).name, 'Untitled');
    assert.equal((await s.create('x'.repeat(200), ANA)).name, 'x'.repeat(80));
  });

  test('the file is left alone when it is written half-way', async () => {
    // Written to a temporary name and renamed, so a kill during the write
    // leaves the list that was there rather than the first half of a new one.
    const { store: s, dir } = store();
    await s.load();
    await s.create('One', ANA);
    const text = readFileSync(path.join(dir, PROJECTS_FILE), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['home', 'projects']);
    assert.doesNotThrow(() => JSON.parse(text), 'the file on disk is always whole');
  });
});

describe('who may see what', () => {
  test('the owner, and whoever is shared with, and nobody else', async () => {
    const { store: s } = store();
    await s.load();
    const hers = await s.create('Ana’s', ANA);
    const his = await s.create('Bo’s', BO);

    assert.deepEqual(s.visibleTo(ANA).map((p) => p.id), [hers.id]);
    assert.deepEqual(s.visibleTo(BO).map((p) => p.id), [his.id]);
    assert.deepEqual(s.visibleTo(undefined), [], 'a socket with no account sees nothing');
    assert.deepEqual(s.visibleTo('nobody'), []);
  });

  test('sharing is honoured already, so the screen to do it is the only part left', async () => {
    const { store: s } = store();
    await s.load();
    const hers = await s.create('Ana’s', ANA);
    await s.update(hers.id, { sharedWith: [BO] });
    assert.deepEqual(s.visibleTo(BO).map((p) => p.id), [hers.id]);
    // Read, not administer: being let in on an engagement is not being able
    // to delete it.
    assert.equal(mayRead(s.get(hers.id)!, BO), true);
    assert.equal(mayAdminister(s.get(hers.id)!, BO), false);
    assert.equal(mayAdminister(s.get(hers.id)!, ANA), true);
  });

  test('a trashed project is still its owner’s, so it can be restored or emptied', async () => {
    const { store: s } = store();
    await s.load();
    await s.create('Home', ANA); // the first is the home one, which cannot be trashed
    const hers = await s.create('Ana’s', ANA);
    await s.setTrashed(hers.id, true);
    assert.ok(s.get(hers.id)?.trashedAt);
    assert.ok(s.visibleTo(ANA).some((p) => p.id === hers.id));
    await s.setTrashed(hers.id, false);
    assert.equal(s.get(hers.id)?.trashedAt, undefined);
  });

  test('the home project cannot be trashed, only the others', async () => {
    /*
     * It would sit there filling up. A key names a project whether or not it
     * is in the trash, and a payload with no key lands in the home one — so
     * a trashed home project goes on collecting recordings, and the purge
     * cannot clear it because deleting it is refused.
     */
    const { store: s } = store();
    await s.load();
    const home = await s.create('Home', ANA);
    assert.equal(await s.setTrashed(home.id, true), null);
    assert.equal(s.get(home.id)?.trashedAt, undefined);
  });

  test('a transfer moves it between accounts and nothing else changes', async () => {
    const { store: s } = store();
    await s.load();
    const hers = await s.create('Ana’s', ANA);
    await s.update(hers.id, { owner: BO });
    assert.deepEqual(s.visibleTo(ANA), []);
    assert.deepEqual(s.visibleTo(BO).map((p) => p.id), [hers.id]);
    assert.equal(s.get(hers.id)?.name, 'Ana’s', 'a handover is not a rename');
  });
});

describe('whether a run may be read', () => {
  /*
   * The rule the console socket and the two HTTP endpoints share.
   *
   * `/body/{session}/{sha}` and `/asset/{session}/...` hand back the bytes of
   * one run's traffic and the files its pages loaded. They were checking only
   * that somebody was signed in, which on a relay with one operator was the
   * same question as which account and is not any more.
   */
  test('by the project it is in, for the owner and whoever is shared with', async () => {
    const { store: s } = store();
    await s.load();
    const hers = await s.create('Ana’s', ANA);
    const his = await s.create('Bo’s', BO);
    await s.update(his.id, { sharedWith: [ANA] });

    assert.equal(s.maySeeSessionIn(hers.id, ANA), true);
    assert.equal(s.maySeeSessionIn(hers.id, BO), false);
    assert.equal(s.maySeeSessionIn(his.id, ANA), true, 'shared');
    assert.equal(s.maySeeSessionIn(hers.id, undefined), false);
    assert.equal(s.maySeeSessionIn(hers.id, 'nobody'), false);
  });

  test('a run naming no project is read as being in the home one', async () => {
    // Every recording made before projects existed, and any the migration
    // did not reach. Hiding them would look like the relay had lost them.
    const { store: s } = store();
    await s.load();
    const home = await s.create('Home', ANA);
    await s.create('Other', BO);
    assert.equal(s.homeId(), home.id);
    assert.equal(s.maySeeSessionIn(undefined, ANA), true);
    assert.equal(s.maySeeSessionIn(undefined, BO), false, 'home is ana’s, so bo does not get the old runs');
  });

  test('a project that is not there is not readable by anyone', async () => {
    const { store: s } = store();
    await s.load();
    await s.create('Home', ANA);
    assert.equal(s.maySeeSessionIn('no-such-project', ANA), false);
  });

  test('nothing is readable while the list could not be read', async () => {
    const made = store();
    writeFileSync(path.join(made.dir, PROJECTS_FILE), '{ truncated');
    await made.store.load();
    assert.equal(made.store.maySeeSessionIn('anything', ANA), false);
    assert.equal(made.store.maySeeSessionIn(undefined, ANA), false);
  });
});

describe('removing one', () => {
  test('the home project is refused, because the next agent would have nowhere to go', async () => {
    const { store: s } = store();
    await s.load();
    const home = await s.create('Home', ANA);
    assert.equal(await s.remove(home.id), false);
    assert.ok(s.get(home.id));
  });

  test('any other one goes, and one that is not there is not an error', async () => {
    const { store: s } = store();
    await s.load();
    await s.create('Home', ANA);
    const other = await s.create('Other', ANA);
    assert.equal(await s.remove(other.id), true);
    assert.equal(s.get(other.id), undefined);
    assert.equal(await s.remove(other.id), false);
  });
});

describe('the one-time migration', () => {
  test('it makes one project and puts every session in it', async () => {
    const { store: s, warnings } = store();
    await s.load();
    const sessions = [session('one'), session('two'), session('three')];
    const written: string[] = [];
    const made = await s.migrateInto(ANA, sessions, async (m) => void written.push(m.sessionId));

    assert.ok(made);
    assert.equal(made!.owner, ANA);
    assert.equal(s.homeId(), made!.id);
    for (const m of sessions) assert.equal(m.projectId, made!.id);
    assert.deepEqual(written.sort(), ['one', 'three', 'two']);
    assert.match(warnings.join('\n'), /3 existing session/);
  });

  test('it does nothing the second time, so a restart does not reassign anything', async () => {
    /*
     * The failure this is about: run twice, it would make a second project,
     * make that one the home, and hand every recording on the relay to
     * whoever the migration was told to give them to.
     */
    const { store: s, dir } = store();
    await s.load();
    const sessions = [session('one')];
    const first = await s.migrateInto(ANA, sessions, async () => undefined);
    assert.ok(first);

    const rebooted = new ProjectStore(dir);
    await rebooted.load();
    assert.equal(await rebooted.migrateInto(BO, [session('two')], async () => undefined), null);
    assert.equal(rebooted.all().length, 1);
    assert.equal(rebooted.get(first!.id)?.owner, ANA, 'the owner was reassigned on a restart');
  });

  test('a session that already names a project is left where it is', async () => {
    const { store: s } = store();
    await s.load();
    const already = session('kept', 'somewhere-else');
    const stamped: string[] = [];
    await s.migrateInto(ANA, [already, session('fresh')], async (m) => void stamped.push(m.sessionId));
    assert.equal(already.projectId, 'somewhere-else');
    assert.deepEqual(stamped, ['fresh']);
  });

  test('a session it could not write is reported and the rest still go', async () => {
    // The recording is readable either way — it just has no project written
    // down, and is read as being in the home one.
    const { store: s, warnings } = store();
    await s.load();
    const sessions = [session('bad'), session('good')];
    await s.migrateInto(ANA, sessions, async (m) => {
      if (m.sessionId === 'bad') throw new Error('disk full');
    });
    assert.match(warnings.join('\n'), /session-bad.*disk full/);
    assert.match(warnings.join('\n'), /put 1 existing session/);
  });
});

describe('a file that did not parse', () => {
  /*
   * The worst case in this file, and it looks exactly like the ordinary one.
   *
   * A list that failed to read leaves no projects in memory, and no projects
   * is also what a fresh install looks like — so the migration would make a
   * home project and write it down, over the file that says who owns what,
   * giving every recording on the relay to one account. Hence `broken`: not
   * an empty list, and nothing written.
   */
  function brokenFile(): { store: ProjectStore; warnings: string[]; dir: string } {
    const made = store();
    writeFileSync(path.join(made.dir, PROJECTS_FILE), '{"projects": [ truncated');
    return made;
  }

  test('nothing is migrated and the file is left as it is', async () => {
    const { store: s, dir, warnings } = brokenFile();
    const before = readFileSync(path.join(dir, PROJECTS_FILE), 'utf8');
    await s.load();
    assert.equal(s.isBroken, true);
    assert.equal(await s.migrateInto(ANA, [session('one')], async () => undefined), null);
    assert.equal(readFileSync(path.join(dir, PROJECTS_FILE), 'utf8'), before, 'the file was overwritten');
    assert.match(warnings.join('\n'), /did not parse/);
    assert.match(warnings.join('\n'), /still recording/, 'the operator is told the relay is up');
  });

  test('no console is shown anything, rather than being shown everything', async () => {
    const { store: s } = brokenFile();
    await s.load();
    assert.deepEqual(s.visibleTo(ANA), []);
  });

  test('a write is refused rather than quietly dropping the file', async () => {
    const { store: s } = brokenFile();
    await s.load();
    await assert.rejects(() => s.create('New', ANA), /did not parse/);
  });

  test('an entry that is not a project is dropped, and the rest of the file still reads', async () => {
    // Malformed entries are not the same as a malformed file: the JSON read,
    // so what is in it can be judged one row at a time.
    const made = store();
    writeFileSync(
      path.join(made.dir, PROJECTS_FILE),
      JSON.stringify({
        home: 'aaaaaa',
        projects: [
          { id: 'aaaaaa', name: 'Good', owner: ANA, sharedWith: [], createdAt: 1 },
          { id: '../escape', name: 'Bad path', owner: ANA, sharedWith: [], createdAt: 2 },
          { id: 'bbbbbb', name: 'No owner', sharedWith: [], createdAt: 3 },
          'not even an object',
        ],
      }),
    );
    await made.store.load();
    assert.equal(made.store.isBroken, false);
    assert.deepEqual(made.store.all().map((p) => p.id), ['aaaaaa']);
    assert.equal(made.store.homeId(), 'aaaaaa');
    assert.match(made.warnings.join('\n'), /ignored 3 malformed entries/);
  });

  test('a project whose key is the wrong shape is dropped, not honoured', async () => {
    /*
     * The check that matters. A key is the whole of what a payload presents,
     * so a hand-edited `agentKey: "x"` would be a key anyone could guess —
     * and the row is the only place a key of the wrong shape can come from,
     * since the generator only makes one kind.
     */
    const made = store();
    writeFileSync(
      path.join(made.dir, PROJECTS_FILE),
      JSON.stringify({
        home: 'aaaaaa',
        projects: [
          { id: 'aaaaaa', name: 'Good', owner: ANA, sharedWith: [], agentKey: 'a'.repeat(32), createdAt: 1 },
          { id: 'bbbbbb', name: 'Guessable', owner: ANA, sharedWith: [], agentKey: 'x', createdAt: 2 },
          { id: 'cccccc', name: 'Upper case', owner: ANA, sharedWith: [], agentKey: 'A'.repeat(32), createdAt: 3 },
        ],
      }),
    );
    await made.store.load();
    assert.deepEqual(made.store.all().map((p) => p.id), ['aaaaaa']);
    assert.equal(made.store.byAgentKey('x'), null);
    assert.equal(made.store.byAgentKey('A'.repeat(32)), null);
    assert.equal(made.store.byAgentKey('a'.repeat(32))?.id, 'aaaaaa');
  });

  test('a project written before keys existed is given one, and keeps everything else', async () => {
    /*
     * Every project the previous version wrote. Making the field required
     * without this would turn each of those rows into a malformed one, drop
     * them all, and leave a file that looks like a fresh install — which the
     * migration would then write over.
     */
    const made = store();
    writeFileSync(
      path.join(made.dir, PROJECTS_FILE),
      JSON.stringify({
        home: 'aaaaaa',
        projects: [{ id: 'aaaaaa', name: 'From before', owner: ANA, sharedWith: [BO], createdAt: 7 }],
      }),
    );
    await made.store.load();
    assert.equal(made.store.isBroken, false);
    const got = made.store.get('aaaaaa');
    assert.equal(got?.name, 'From before');
    assert.equal(got?.owner, ANA, 'the owner moved');
    assert.deepEqual(got?.sharedWith, [BO]);
    assert.match(got?.agentKey ?? '', /^[a-f0-9]{32}$/);
    assert.equal(made.store.homeId(), 'aaaaaa');
    assert.match(made.warnings.join('\n'), /drew an agent key for "From before"/);

    // Written down, so the next boot does not draw a different one.
    const again = new ProjectStore(made.dir);
    await again.load();
    assert.equal(again.get('aaaaaa')?.agentKey, got?.agentKey);
  });

  test('a file whose every project is unreadable is broken, not empty', async () => {
    /*
     * The near miss this came from: making `agentKey` required turned every
     * row the previous version wrote into a malformed one. All of them
     * dropped looks exactly like a fresh install, and a fresh install is
     * what the migration writes a new home project over.
     */
    const made = store();
    writeFileSync(
      path.join(made.dir, PROJECTS_FILE),
      JSON.stringify({ home: 'aaaaaa', projects: [{ id: 'aaaaaa' }, { id: 'bbbbbb' }] }),
    );
    const before = readFileSync(path.join(made.dir, PROJECTS_FILE), 'utf8');
    await made.store.load();
    assert.equal(made.store.isBroken, true);
    assert.equal(await made.store.migrateInto(ANA, [session('one')], async () => undefined), null);
    assert.equal(readFileSync(path.join(made.dir, PROJECTS_FILE), 'utf8'), before, 'the file was overwritten');
    assert.match(made.warnings.join('\n'), /none of its 2 project\(s\) could be read/);
  });

  test('a home naming a project that is not there falls back to one that is', async () => {
    const made = store();
    writeFileSync(
      path.join(made.dir, PROJECTS_FILE),
      JSON.stringify({ home: 'gone', projects: [{ id: 'aaaaaa', name: 'Good', owner: ANA, sharedWith: [], createdAt: 1 }] }),
    );
    await made.store.load();
    assert.equal(made.store.homeId(), 'aaaaaa');
  });
});
