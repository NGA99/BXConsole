/**
 * Two bits of parsing the user types at directly, where getting it wrong is
 * silent: the Network filter box reading a path as a regular expression, and
 * the attribute editor truncating a value at its first quote.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter } from '../src/panels/network/filters';
import { parseAttributeEdit } from '../src/panels/elements/attr-edit';
import type { NetworkEntry } from '../src/state/session-data';

/** Just enough of an entry for a URL filter to work on. */
const entry = (url: string) =>
  ({ request: { url, method: 'GET', headers: {}, ts: 0, kind: 'fetch' } }) as unknown as NetworkEntry;

describe('the network filter box', () => {
  test('a path is a substring, not a regular expression', () => {
    // `im` and `s` and `y` are all valid regex flags, which is how
    // /assets/im used to become /assets/ and match far too much.
    for (const [term, hit, miss] of [
      ['/assets/im', 'http://x/assets/images/a.png', 'http://x/assets/js/a.js'],
      ['/v1/s', 'http://x/v1/stock', 'http://x/v1/orders'],
      ['/a/y', 'http://x/a/year', 'http://x/a/month'],
    ] as const) {
      const p = compileFilter(term, false);
      assert.ok(p(entry(hit)), `${term} should match ${hit}`);
      assert.ok(!p(entry(miss)), `${term} should not match ${miss}`);
    }
  });

  test('/regex/ is still a regular expression', () => {
    const p = compileFilter('/\\.(png|jpg)$/', false);
    assert.ok(p(entry('http://x/a.png')));
    assert.ok(!p(entry('http://x/a.css')));
  });

  test('an unparseable regex falls back to a substring', () => {
    const p = compileFilter('/[unclosed/', false);
    assert.ok(p(entry('http://x/[unclosed/y')));
  });

  test('terms are ANDed, - negates, invert flips the lot', () => {
    assert.ok(compileFilter('assets png', false)(entry('http://x/assets/a.png')));
    assert.ok(!compileFilter('assets png', false)(entry('http://x/assets/a.css')));
    assert.ok(compileFilter('-png', false)(entry('http://x/a.css')));
    assert.ok(!compileFilter('assets', true)(entry('http://x/assets/a.png')));
  });
});

describe('the attribute editor', () => {
  test('a quoted value keeps the quotes inside it', () => {
    assert.deepEqual(parseAttributeEdit('data-json="{"a":1}"'), { name: 'data-json', value: '{"a":1}' });
    assert.deepEqual(parseAttributeEdit("title='he said \"hi\"'"), { name: 'title', value: 'he said "hi"' });
  });

  test('the plain forms still work', () => {
    assert.deepEqual(parseAttributeEdit('hidden'), { name: 'hidden', value: '' });
    assert.deepEqual(parseAttributeEdit('id=main'), { name: 'id', value: 'main' });
    assert.deepEqual(parseAttributeEdit('  class = "a b"  '), { name: 'class', value: 'a b' });
    assert.deepEqual(parseAttributeEdit('data-x=""'), { name: 'data-x', value: '' });
  });

  test('nothing usable is rejected rather than guessed at', () => {
    assert.equal(parseAttributeEdit(''), null);
    assert.equal(parseAttributeEdit('   '), null);
    assert.equal(parseAttributeEdit('=novalue'), null);
  });
});
