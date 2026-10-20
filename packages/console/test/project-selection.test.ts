/**
 * Which project the console is looking at.
 *
 * It scopes everything: the session list, and the key in the snippet the
 * Agent tab hands out. So the failures here are quiet ones — a console
 * scoped to a project it cannot read shows an empty list and no reason, and a
 * snippet built from the wrong project records somebody else's engagement.
 *
 * The selection is kept in localStorage, which means it outlives the account
 * that chose it: signing in as somebody else on the same browser finds an id
 * that is not in their list.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '@bxconsole/protocol';

/** A localStorage stand-in, since this runs in node. */
const held: Record<string, string> = {};
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => held[k] ?? null,
  setItem: (k: string, v: string) => void (held[k] = v),
  removeItem: (k: string) => void delete held[k],
};

const { useProjectsStore, selectProject } = await import('../src/state/projects');

/**
 * What useSnippetProject reads.
 *
 * The hook itself cannot be called here — it is a React hook and there is no
 * component — so these go at the store underneath it, which is where the
 * logic worth testing lives.
 */
function selected(): Project | null {
  const s = useProjectsStore.getState();
  return s.selectedId ? (s.byId[s.selectedId] ?? null) : null;
}

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  owner: 'a1a1a1',
  sharedWith: [],
  agentKey: id.repeat(32).slice(0, 32),
  createdAt: 1,
  ...over,
});

const state = () => useProjectsStore.getState();

beforeEach(() => {
  for (const k of Object.keys(held)) delete held[k];
  useProjectsStore.setState({ byId: {}, order: [], homeId: '', selectedId: '' });
});

describe('settling on a project', () => {
  test('with nothing chosen it is the home one', () => {
    state().setAll([project('a'), project('home'), project('c')], 'home');
    assert.equal(state().selectedId, 'home');
  });

  test('with no home it is the newest, which the list is ordered by', () => {
    // The relay sends them newest first, and the newest project is the
    // engagement being set up.
    state().setAll([project('newest'), project('older')], '');
    assert.equal(state().selectedId, 'newest');
  });

  test('a home project this account cannot read is not chosen', () => {
    /*
     * The home project is relay-wide and belongs to whoever set the relay up.
     * Every other account would be scoped to a project missing from their own
     * list, which shows an empty session list and no reason for it.
     */
    state().setAll([project('mine')], 'someone-elses');
    assert.equal(state().selectedId, 'mine');
  });

  test('an account with no projects selects nothing rather than something', () => {
    state().setAll([], 'someone-elses');
    assert.equal(state().selectedId, '');
    // Which is what the Agent tab reads: no project, so no key, and it says
    // so rather than handing out a payload the relay will refuse.
    assert.equal(selected(), null);
  });
});

describe('remembering it', () => {
  test('a choice is kept and taken up again on the next connection', () => {
    state().setAll([project('a'), project('b')], 'a');
    selectProject('b');
    assert.equal(state().selectedId, 'b');

    // A fresh console, same browser.
    useProjectsStore.setState({ byId: {}, order: [], homeId: '', selectedId: '' });
    state().setAll([project('a'), project('b')], 'a');
    assert.equal(state().selectedId, 'b', 'the choice was forgotten');
  });

  test('a stored choice that is not in the list is replaced, not kept', () => {
    // Signing in as somebody else on the same browser, or a project shared
    // away. Keeping it would scope the console to something it cannot read.
    state().setAll([project('a'), project('b')], 'a');
    selectProject('b');
    useProjectsStore.setState({ byId: {}, order: [], homeId: '', selectedId: '' });

    state().setAll([project('theirs'), project('home')], 'home');
    assert.equal(state().selectedId, 'home');
  });

  test('a project arriving or leaving does not move you off what you were reading', () => {
    state().setAll([project('a'), project('b')], 'a');
    selectProject('b');
    state().setAll([project('new'), project('a'), project('b')], 'a');
    assert.equal(state().selectedId, 'b');
  });

  test('choosing something that is not there is ignored', () => {
    state().setAll([project('a')], 'a');
    selectProject('nope');
    assert.equal(state().selectedId, 'a');
  });
});

describe('as projects come and go', () => {
  test('a project made here becomes the one being looked at', () => {
    // Making one is how you say what you are about to work on.
    state().setAll([], '');
    state().upsert(project('fresh'));
    assert.equal(state().selectedId, 'fresh');
  });

  test('a change to some other project leaves the selection alone', () => {
    state().setAll([project('a'), project('b')], 'a');
    selectProject('b');
    state().upsert(project('a', { name: 'renamed' }));
    assert.equal(state().selectedId, 'b');
    assert.equal(state().byId['a']?.name, 'renamed');
  });

  test('the one being looked at going away falls back to one that is there', () => {
    state().setAll([project('a'), project('home')], 'home');
    selectProject('a');
    state().remove('a');
    assert.equal(state().selectedId, 'home');
  });

  test('the last project going away leaves nothing selected', () => {
    state().setAll([project('only')], 'only');
    state().remove('only');
    assert.equal(state().selectedId, '');
    assert.equal(state().homeId, '');
  });
});

describe('the key the snippet carries', () => {
  test('it is the selected project’s, so the list and the snippet agree', () => {
    state().setAll([project('a'), project('b')], 'a');
    selectProject('b');
    assert.equal(selected()?.agentKey, project('b').agentKey);
  });

  test('a rotated key is picked up without choosing anything again', () => {
    state().setAll([project('a')], 'a');
    const rotated = { ...project('a'), agentKey: 'f'.repeat(32) };
    state().upsert(rotated);
    assert.equal(state().byId['a']?.agentKey, 'f'.repeat(32));
    assert.equal(state().selectedId, 'a');
  });
});
