/**
 * What a page can put in the relay's index.
 *
 * `page.navigated` carries the url and title from the debugged page into
 * `meta.json` with nothing at runtime in between, and a run that reported
 * `url: null, title: 12` had exactly that written to disk.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { usableTabPatch, URL_MAX, TITLE_MAX } from '../src/tab-patch';

describe('usableTabPatch', () => {
  test('an ordinary navigation passes through untouched', () => {
    const patch = { url: 'https://app.example/orders?id=4', title: 'Orders' };
    assert.deepEqual(usableTabPatch(patch), patch);
  });

  test('a field that is not a string is dropped, not coerced', () => {
    // String(12) would put "12" in the index as though the page had said so.
    // The event itself is in the ndjson either way.
    assert.deepEqual(usableTabPatch({ url: null, title: 12 } as never), {});
    assert.deepEqual(usableTabPatch({ url: { href: 'x' } } as never), {});
    assert.deepEqual(usableTabPatch({ title: ['a'] } as never), {});
  });

  test('dropping one leaves the other alone', () => {
    assert.deepEqual(usableTabPatch({ url: 'https://app.example/', title: 12 } as never), { url: 'https://app.example/' });
  });

  test('an empty string is a real answer and is kept', () => {
    // A page with no title has an empty one; that is not the same as silence.
    assert.deepEqual(usableTabPatch({ title: '' }), { title: '' });
  });

  test('a field nobody sent is not invented', () => {
    assert.deepEqual(usableTabPatch({}), {});
    assert.equal('url' in usableTabPatch({ title: 'x' }), false);
  });

  test('a value too long for anybody to mean is cut', () => {
    // The index is read in full every time the console lists sessions.
    const huge = `https://app.example/?q=${'x'.repeat(URL_MAX * 2)}`;
    const out = usableTabPatch({ url: huge });
    assert.equal(out.url!.length, URL_MAX);
    assert.ok(huge.startsWith(out.url!), 'what is kept is the start of what was sent');
    assert.equal(usableTabPatch({ title: 'y'.repeat(TITLE_MAX + 5) }).title!.length, TITLE_MAX);
  });

  test('other fields are left for whoever set them', () => {
    // Only the two a page chooses are its to get wrong.
    assert.deepEqual(usableTabPatch({ connected: false, tabId: 'abc' } as never), { connected: false, tabId: 'abc' });
  });
});
