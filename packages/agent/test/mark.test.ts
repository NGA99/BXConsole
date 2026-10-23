/**
 * The one token every trace the agent leaves is built from.
 *
 * A payload running in someone else's browser writes a global, a few window
 * markers, two sessionStorage keys and the name of a frame it hosts. They all
 * derive from the mark, so that a defender grepping for the product's name
 * finds nothing — and `data-mark` replaces it per engagement, because a fixed
 * neutral token is only one grep better than a fixed obvious one.
 *
 * Two properties carry that, and neither had a test: a value the page could
 * not hold as a property name must be refused rather than used, and the mark
 * has to be the same for the life of a window, or a reload starts a new run.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

async function fresh() {
  return (await import(`../src/mark?${Math.random()}`)) as {
    DEFAULT_MARK: string;
    setMark: (v: string | null | undefined) => void;
    markName: () => string;
    flagName: (s: string) => string;
    storeKey: (s: string) => string;
  };
}

describe('choosing the mark', () => {
  test('a name the engagement picked is used everywhere', async () => {
    const m = await fresh();
    m.setMark('_q7');
    assert.equal(m.markName(), '_q7');
    assert.equal(m.storeKey('session'), '_q7_session');
    assert.equal(m.flagName('Hosting'), '_q7Hosting');
  });

  test('the default says nothing about the product', async () => {
    const m = await fresh();
    assert.equal(m.markName(), m.DEFAULT_MARK);
    assert.ok(!/bx|console|wave/i.test(m.DEFAULT_MARK), `${m.DEFAULT_MARK} is a grep`);
  });

  test('a value that is not a property name is refused, not used', async () => {
    // Every derived key would break silently, and the run would leave traces
    // under names nothing reads back.
    const m = await fresh();
    for (const bad of ['has space', '1leading', 'dash-ed', 'dot.ted', '', 'x'.repeat(40), 'quote"', 'semi;colon']) {
      m.setMark(bad);
      assert.equal(m.markName(), m.DEFAULT_MARK, `${JSON.stringify(bad)} was accepted`);
    }
  });

  test('nothing at all leaves the default in place', async () => {
    const m = await fresh();
    m.setMark(null);
    m.setMark(undefined);
    assert.equal(m.markName(), m.DEFAULT_MARK);
  });

  test('a refused value does not undo a good one set before it', async () => {
    const m = await fresh();
    m.setMark('_q7');
    m.setMark('not a name');
    assert.equal(m.markName(), '_q7', 'the run would have moved to new storage keys mid-flight');
  });

  test('every derived name moves together, so nothing is left under the old one', async () => {
    const m = await fresh();
    const before = [m.storeKey('session'), m.storeKey('tab'), m.flagName('Hosting')];
    m.setMark('_zz9');
    const after = [m.storeKey('session'), m.storeKey('tab'), m.flagName('Hosting')];
    assert.equal(after.filter((n, i) => n === before[i]).length, 0);
    for (const n of after) assert.match(n, /^_zz9/);
  });
});
