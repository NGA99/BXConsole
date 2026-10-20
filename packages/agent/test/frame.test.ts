/**
 * Telling a window that is already somebody's scaffolding.
 *
 * Hosting keeps a flag on the window so a second copy of the script does not
 * wrap the wrapper — but that flag is named from the mark, and two snippets
 * pasted into one page with different marks cannot see each other's. What
 * happened then was not two runs, it was one page framed twice: the second
 * agent hid the frame holding the live run and put the app another level
 * down inside a frame of its own.
 *
 * No name helps here. A mark-independent one is the fixed token mark.ts
 * exists to keep out of the page. So the guard reads the arrangement instead:
 * a window holding a frame of its own URL is already hosting one.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hostsOwnPage } from '../src/hooks/frame';

const HREF = 'https://app.test/checkout';

/** Enough of a document for the check: body's children and a location. */
function page(children: Array<{ tagName: string; src?: string }>, href = HREF) {
  (globalThis as any).document = { body: { children } };
  (globalThis as any).location = { href };
}

const el = (tagName: string, src?: string) => ({ tagName, src });

const clear = () => {
  delete (globalThis as any).document;
  delete (globalThis as any).location;
};
beforeEach(clear);
afterEach(clear);

describe('a page nobody is hosting', () => {
  test('an ordinary document is not a wrapper', () => {
    page([el('DIV'), el('HEADER'), el('SCRIPT')]);
    assert.equal(hostsOwnPage(), false);
  });

  test('the frames a page makes for itself are the app’s own', () => {
    // An ad slot, a payment form, a chat widget: all iframes, none of them us.
    page([el('IFRAME', 'https://ads.test/slot'), el('IFRAME', 'https://pay.test/card')]);
    assert.equal(hostsOwnPage(), false);
  });

  test('a frame of a sibling page is not a frame of this one', () => {
    page([el('IFRAME', 'https://app.test/cart')]);
    assert.equal(hostsOwnPage(), false);
  });

  test('before <body> exists there is nothing to find', () => {
    // Which is why hostInIframe asks again once the body arrives: the snippet
    // belongs in <head>, where neither agent has wrapped anything yet.
    (globalThis as any).document = { currentScript: null };
    (globalThis as any).location = { href: HREF };
    assert.equal(hostsOwnPage(), false);
  });

  test('a document that refuses to be read is not a wrapper either', () => {
    (globalThis as any).document = { get body(): never { throw new Error('no'); } };
    (globalThis as any).location = { href: HREF };
    assert.doesNotThrow(() => hostsOwnPage());
    assert.equal(hostsOwnPage(), false);
  });
});

describe('a page a host already took over', () => {
  test('the frame a wrapper left behind is recognised', () => {
    // What wrap() leaves: the page's own children hidden, its frame appended.
    page([el('DIV'), el('IFRAME', HREF)]);
    assert.equal(hostsOwnPage(), true);
  });

  test('recognised whatever mark the first agent was carrying', () => {
    // The frame's name is built from that mark and is deliberately not read
    // here; this is the one check two marks must still agree on.
    page([el('IFRAME', HREF)]);
    assert.equal(hostsOwnPage(), true);
  });
});
