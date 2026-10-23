/**
 * Which run a window belongs to, and which window it is.
 *
 * A window opened by another inherits a *copy* of its sessionStorage, so the
 * tab id it finds there is the opener's, not its own. Two windows reporting
 * the same id means the relay sees one window and the console shows one
 * window, with the second one's traffic landing under the first. These rules
 * are in comments and had no test.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../src/config';

let store: Map<string, string>;

/** A window the module can read, with an optional opener that has an agent. */
function stubWindow(opener?: { closed: boolean; handle?: { tabId: string } }) {
  store = new Map();
  const win: Record<string, unknown> = {
    opener: opener ? { closed: opener.closed, __wv: opener.handle } : null,
  };
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  return win;
}

async function fresh() {
  return (await import(`../src/session?${Math.random()}`)) as {
    getOrCreateSession: (c: AgentConfig) => { sessionId: string };
    getOrCreateTab: (c: AgentConfig) => { tabId: string; openedBy?: string };
  };
}

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig => ({ sessionId: null, tabId: null, ...over }) as AgentConfig;

beforeEach(() => stubWindow());
afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

describe('which run this window belongs to', () => {
  test('a pinned session id is used and remembered', async () => {
    const { getOrCreateSession } = await fresh();
    assert.equal(getOrCreateSession(cfg({ sessionId: 'abc123def456' })).sessionId, 'abc123def456');
    assert.ok([...store.values()].some((v) => v.includes('abc123def456')), 'it did not survive for the next load');
  });

  test('a pinned id that is not a usable id is ignored rather than trusted', async () => {
    const { getOrCreateSession } = await fresh();
    const got = getOrCreateSession(cfg({ sessionId: '../../etc/passwd' })).sessionId;
    assert.notEqual(got, '../../etc/passwd');
    assert.match(got, /^[A-Za-z0-9_-]{1,64}$/);
  });

  test('a reload of the same window stays in the same run', async () => {
    const first = await fresh();
    const id = first.getOrCreateSession(cfg()).sessionId;
    const second = await fresh();
    assert.equal(second.getOrCreateSession(cfg()).sessionId, id);
  });
});

describe('which window this is', () => {
  test('a window with no opener keeps the id it stored', async () => {
    const first = await fresh();
    const tabId = first.getOrCreateTab(cfg()).tabId;
    const second = await fresh();
    assert.equal(second.getOrCreateTab(cfg()).tabId, tabId, 'a reload became a different window');
  });

  test('a window opened by another does not take the opener’s id', async () => {
    // The whole point: sessionStorage is copied into the new window, so the
    // id it finds there belongs to the window that opened it.
    const opener = { closed: false, handle: { tabId: 'openerTab1' } };
    stubWindow(opener);
    store.set('__wv_tab', JSON.stringify({ tabId: 'openerTab1', startedAt: 1 }));
    const { getOrCreateTab } = await fresh();
    const tab = getOrCreateTab(cfg());
    assert.notEqual(tab.tabId, 'openerTab1', 'two windows would have reported the same id');
    assert.equal(tab.openedBy, 'openerTab1', 'and the console could not have drawn the tree');
  });

  test('a stored id that is not the opener’s is still this window’s own', async () => {
    // Opened by another, then reloaded: by then the stored id is its own.
    const opener = { closed: false, handle: { tabId: 'openerTab1' } };
    stubWindow(opener);
    store.set('__wv_tab', JSON.stringify({ tabId: 'myOwnTab9', startedAt: 1 }));
    const { getOrCreateTab } = await fresh();
    assert.equal(getOrCreateTab(cfg()).tabId, 'myOwnTab9');
  });

  test('a cross-origin opener is not an error, just no parent', async () => {
    (globalThis as Record<string, unknown>).window = {
      get opener() {
        throw new Error('cross-origin');
      },
    };
    const { getOrCreateTab } = await fresh();
    assert.doesNotThrow(() => getOrCreateTab(cfg()));
  });

  test('a pinned window id wins, which is how a supervisor adopts one', async () => {
    const { getOrCreateTab } = await fresh();
    assert.equal(getOrCreateTab(cfg({ tabId: 'pinned00tab' })).tabId, 'pinned00tab');
  });
});
