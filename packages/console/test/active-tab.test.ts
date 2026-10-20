/**
 * Remembering which window of a run the console was pointed at.
 *
 * The pick has to outlive a reload. Without that it is derived again from
 * nothing, and the only thing left to derive it from is which windows are
 * still live — so a run whose later windows had closed came back pointed at
 * its first one, taking the console output being read with it.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'bxconsole.activeTab';

/** A localStorage that behaves, or one that refuses, as a private window does. */
function stubStorage(opts: { throws?: boolean } = {}) {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => {
      if (opts.throws) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throws) throw new Error('denied');
      map.set(k, v);
    },
  };
  return map;
}

/** A fresh copy of the module, so the load-at-import is part of the test. */
async function freshModule() {
  return (await import(`../src/state/active-tab?x=${Math.random()}`)) as typeof import('../src/state/active-tab');
}

beforeEach(() => stubStorage());

describe('the pick survives a reload', () => {
  test('what was set is read back by the next page', async () => {
    const first = await freshModule();
    first.setActiveTab('run-1', 'tab-C');
    // "reload": the store is gone, the storage is not.
    const next = await freshModule();
    assert.equal(next.activeTabOf('run-1'), 'tab-C');
  });

  test('each run is remembered separately', async () => {
    const m = await freshModule();
    m.setActiveTab('run-1', 'tab-C');
    m.setActiveTab('run-2', 'tab-A');
    const next = await freshModule();
    assert.equal(next.activeTabOf('run-1'), 'tab-C');
    assert.equal(next.activeTabOf('run-2'), 'tab-A');
  });

  test('a run never picked has no pick, so the strip chooses one', async () => {
    const m = await freshModule();
    assert.equal(m.activeTabOf('never-seen'), undefined);
  });

  test('null is a pick too — it means show the whole run', async () => {
    const m = await freshModule();
    m.setActiveTab('run-1', 'tab-C');
    m.setActiveTab('run-1', null);
    const next = await freshModule();
    assert.equal(next.activeTabOf('run-1'), undefined);
  });
});

describe('it does not grow without end', () => {
  test('old runs fall off and recent ones stay', async () => {
    const m = await freshModule();
    for (let i = 0; i < 130; i++) m.setActiveTab(`run-${i}`, `tab-${i}`);
    const next = await freshModule();
    assert.equal(next.activeTabOf('run-0'), undefined, 'the oldest should have been dropped');
    assert.equal(next.activeTabOf('run-129'), 'tab-129', 'the newest must be kept');
    assert.equal(next.activeTabOf('run-100'), 'tab-100');
  });

  test('picking a run again makes it recent, so it is not dropped', async () => {
    const m = await freshModule();
    m.setActiveTab('old-run', 'tab-A');
    for (let i = 0; i < 99; i++) m.setActiveTab(`run-${i}`, `tab-${i}`);
    m.setActiveTab('old-run', 'tab-B'); // looked at again
    for (let i = 0; i < 50; i++) m.setActiveTab(`later-${i}`, `tab-${i}`);
    const next = await freshModule();
    assert.equal(next.activeTabOf('old-run'), 'tab-B');
  });
});

describe('storage that will not cooperate', () => {
  test('a private window still works, it just forgets', async () => {
    stubStorage({ throws: true });
    const m = await freshModule();
    assert.doesNotThrow(() => m.setActiveTab('run-1', 'tab-C'));
    // the pick is still good for this page
    assert.equal(m.activeTabOf('run-1'), 'tab-C');
  });

  test('junk in storage is ignored rather than thrown', async () => {
    const map = stubStorage();
    for (const junk of ['not json', '[]', 'null', '{"run-1":42}', '"a string"']) {
      map.set(KEY, junk);
      const m = await freshModule();
      assert.doesNotThrow(() => m.activeTabOf('run-1'));
      assert.equal(m.activeTabOf('run-1'), undefined, junk);
    }
  });
});
