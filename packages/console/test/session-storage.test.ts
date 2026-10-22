import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetSessionStorage, keysFor } from '../src/state/session-storage';

/** A store that records what it was asked to remove. */
function store(opts: { throws?: boolean } = {}) {
  const gone: string[] = [];
  return {
    gone,
    removeItem(key: string) {
      if (opts.throws) throw new Error('denied');
      gone.push(key);
    },
  };
}

test('every note this console keeps about a run goes with the run', () => {
  const s = store();
  forgetSessionStorage('abc123', s);
  assert.deepEqual(s.gone.sort(), keysFor('abc123').sort());
  // Named so a key added later is caught here rather than left behind.
  assert.deepEqual(keysFor('abc123'), ['bxconsole.network.config.abc123', 'bxconsole.live.abc123']);
});

test('one run at a time: a run whose id starts the same is untouched', () => {
  const s = store();
  forgetSessionStorage('abc', s);
  assert.ok(!s.gone.includes('bxconsole.live.abc123'), 'abc123 is a different run from abc');
});

test('no id deletes nothing, rather than deleting the bare prefixes', () => {
  const s = store();
  forgetSessionStorage('', s);
  assert.deepEqual(s.gone, []);
});

test('a window that refuses storage is not an error here', () => {
  // The run is gone from the relay either way; this is only the local copy.
  assert.doesNotThrow(() => forgetSessionStorage('abc123', store({ throws: true })));
  assert.doesNotThrow(() => forgetSessionStorage('abc123', null));
});
