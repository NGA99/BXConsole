/**
 * Climbing the chain of windows that opened this one.
 *
 * The agent usually lands part-way through a flow that already spans several
 * windows, and reaches the rest through `window.opener`. The walk runs inside
 * a victim's browser, on a page nobody can look at, so its stopping rules are
 * the whole safety of it: a cycle or an unbounded climb is a hang in somebody
 * else's tab, and a cross-origin window must end the walk rather than be
 * counted or climbed past.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../src/config';

/** A window that can be installed into, with an opener of its own. */
function fakeWindow(opts: { closed?: boolean; crossOrigin?: boolean } = {}) {
  const appended: unknown[] = [];
  const el = { set src(_v: string) {}, get src() { return ''; } };
  const win: Record<string, unknown> = {
    closed: opts.closed ?? false,
    opener: null,
    appended,
    get document() {
      if (opts.crossOrigin) throw new Error('cross-origin');
      return {
        createElement: () => el,
        head: { appendChild: (n: unknown) => void appended.push(n) },
        documentElement: { appendChild: (n: unknown) => void appended.push(n) },
      };
    },
  };
  return win;
}

/** this window, plus a chain of openers above it */
function chain(n: number) {
  const self = fakeWindow();
  let cur = self;
  const made: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const up = fakeWindow();
    cur.opener = up;
    made.push(up);
    cur = up;
  }
  return { self, made };
}

const cfg = { serverUrl: 'ws://relay.test/ws/agent', key: null, name: null } as unknown as AgentConfig;

async function fresh(self: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).window = self;
  (globalThis as Record<string, unknown>).location = { href: 'http://victim.test/' };
  return (await import(`../src/hooks/adopt?${Math.random()}`)) as {
    adoptOpeners: (c: AgentConfig, sessionId: string) => number;
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).location;
});

describe('walking up the openers', () => {
  test('reaches a short chain and says how many', async () => {
    const { self, made } = chain(3);
    const { adoptOpeners } = await fresh(self);
    assert.equal(adoptOpeners(cfg, 'sess01'), 3);
    for (const w of made) assert.equal((w.appended as unknown[]).length, 1, 'a window was not given the agent');
  });

  test('stops at a depth rather than climbing for ever', async () => {
    // Six is the limit; a chain of twenty must not be walked to the end.
    const { self } = chain(20);
    const { adoptOpeners } = await fresh(self);
    assert.equal(adoptOpeners(cfg, 'sess01'), 6);
  });

  test('a cycle ends the walk instead of hanging the page', async () => {
    const a = fakeWindow();
    const b = fakeWindow();
    const self = fakeWindow();
    self.opener = a;
    a.opener = b;
    b.opener = a; // round and round
    const { adoptOpeners } = await fresh(self);
    assert.equal(adoptOpeners(cfg, 'sess01'), 2, 'it should reach a and b once each and stop');
  });

  test('a window pointing back at this one is not installed into twice', async () => {
    const self = fakeWindow();
    const a = fakeWindow();
    self.opener = a;
    a.opener = self;
    const { adoptOpeners } = await fresh(self);
    assert.equal(adoptOpeners(cfg, 'sess01'), 1);
    assert.equal((self.appended as unknown[]).length, 0, 'it installed into the window it was already in');
  });

  test('a cross-origin window ends the walk and is not counted', async () => {
    // Touching its document throws; anything above it is unreachable too.
    const self = fakeWindow();
    const foreign = fakeWindow({ crossOrigin: true });
    const above = fakeWindow();
    self.opener = foreign;
    foreign.opener = above;
    const { adoptOpeners } = await fresh(self);
    assert.equal(adoptOpeners(cfg, 'sess01'), 0);
    assert.equal((above.appended as unknown[]).length, 0, 'it climbed past a window it could not read');
  });

  test('a closed opener ends the walk', async () => {
    const self = fakeWindow();
    const gone = fakeWindow({ closed: true });
    self.opener = gone;
    const { adoptOpeners } = await fresh(self);
    assert.equal(adoptOpeners(cfg, 'sess01'), 0);
  });

  test('no opener at all is simply nothing to do', async () => {
    const { adoptOpeners } = await fresh(fakeWindow());
    assert.equal(adoptOpeners(cfg, 'sess01'), 0);
  });
});
