/**
 * Keeping another window carrying the agent.
 *
 * One install is not enough: every navigation in that window drops the agent
 * with the old document, and nothing inside it can bring the agent back. So a
 * supervisor outside it polls and re-installs. That poll runs in a victim's
 * browser, on a page nobody is watching, which makes two things matter as
 * much as the feature — that it stops when there is nothing left to watch,
 * and that it survives a window going cross-origin without giving up.
 */
import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../src/config';

function childWindow(opts: { href?: string; crossOrigin?: boolean } = {}) {
  const appended: unknown[] = [];
  const el = { set src(_v: string) {}, get src() { return ''; } };
  const state = { closed: false, href: opts.href ?? 'http://victim.test/a', crossOrigin: opts.crossOrigin ?? false };
  const win: Record<string, unknown> = {
    appended,
    state,
    get closed() { return state.closed; },
    get location() {
      if (state.crossOrigin) throw new Error('cross-origin');
      return { href: state.href };
    },
    get document() {
      if (state.crossOrigin) throw new Error('cross-origin');
      return {
        createElement: () => el,
        head: { appendChild: (n: unknown) => void appended.push(n) },
        documentElement: { appendChild: (n: unknown) => void appended.push(n) },
      };
    },
  };
  return win;
}

const cfg = { serverUrl: 'ws://relay.test/ws/agent', key: null, name: null } as unknown as AgentConfig;

async function fresh() {
  (globalThis as Record<string, unknown>).window = { closed: false };
  (globalThis as Record<string, unknown>).location = { href: 'http://victim.test/' };
  return (await import(`../src/hooks/adopt?${Math.random()}`)) as {
    watchWindow: (c: unknown, cfg: AgentConfig, sid: string) => () => void;
  };
}

beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
afterEach(() => {
  mock.timers.reset();
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).location;
});

describe('watching a window', () => {
  test('puts the agent in and does not keep putting it in', async () => {
    const { watchWindow } = await fresh();
    const child = childWindow();
    watchWindow(child, cfg, 'sess01');
    mock.timers.tick(1000);
    assert.equal((child.appended as unknown[]).length, 1, 'it installed on every tick');
  });

  test('puts it back after the window navigates', async () => {
    // The whole reason the supervisor exists.
    const { watchWindow } = await fresh();
    const child = childWindow();
    watchWindow(child, cfg, 'sess01');
    mock.timers.tick(300);
    (child.state as { href: string }).href = 'http://victim.test/b';
    mock.timers.tick(300);
    assert.equal((child.appended as unknown[]).length, 2);
  });

  test('about:blank is not a document to adopt yet', async () => {
    const { watchWindow } = await fresh();
    const child = childWindow({ href: 'about:blank' });
    watchWindow(child, cfg, 'sess01');
    mock.timers.tick(1000);
    assert.equal((child.appended as unknown[]).length, 0);
  });

  test('a window gone cross-origin is not given up on', async () => {
    const { watchWindow } = await fresh();
    const child = childWindow({ crossOrigin: true });
    watchWindow(child, cfg, 'sess01');
    mock.timers.tick(600);
    assert.equal((child.appended as unknown[]).length, 0, 'it cannot be touched while it is elsewhere');
    (child.state as { crossOrigin: boolean }).crossOrigin = false;
    mock.timers.tick(300);
    assert.equal((child.appended as unknown[]).length, 1, 'it came back to our origin and was not picked up');
  });

  test('a closed window stops the poll rather than leaving a timer behind', async () => {
    const { watchWindow } = await fresh();
    const child = childWindow();
    watchWindow(child, cfg, 'sess01');
    mock.timers.tick(300);
    (child.state as { closed: boolean }).closed = true;
    mock.timers.tick(300);
    const after = (child.appended as unknown[]).length;
    (child.state as { closed: boolean }).closed = false;
    mock.timers.tick(3000);
    assert.equal((child.appended as unknown[]).length, after, 'the timer outlived the window');
  });

  test('stopping it stops the poll', async () => {
    const { watchWindow } = await fresh();
    const child = childWindow();
    const stop = watchWindow(child, cfg, 'sess01');
    mock.timers.tick(300);
    const after = (child.appended as unknown[]).length;
    stop();
    (child.state as { href: string }).href = 'http://victim.test/c';
    mock.timers.tick(3000);
    assert.equal((child.appended as unknown[]).length, after);
  });

  test('watching the same window twice does not start a second poll', async () => {
    const { watchWindow } = await fresh();
    const child = childWindow();
    watchWindow(child, cfg, 'sess01');
    watchWindow(child, cfg, 'sess01');
    mock.timers.tick(300);
    (child.state as { href: string }).href = 'http://victim.test/d';
    mock.timers.tick(300);
    assert.equal((child.appended as unknown[]).length, 2, 'two timers were installing into one window');
  });

  test('nothing to watch is nothing to stop', async () => {
    const { watchWindow } = await fresh();
    assert.doesNotThrow(() => watchWindow(null, cfg, 'sess01')());
  });
});
