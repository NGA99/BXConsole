/**
 * Specificity decides which declarations the Styles pane strikes out, so
 * being wrong here does not look like a bug — it looks like the page.
 *
 * The numbers are CSS's own: [ids, classes+attributes+pseudo-classes,
 * elements+pseudo-elements].
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSpec, specificity, splitSelectorList } from '../src/css-selectors';

describe('specificity', () => {
  const cases: Array<[string, [number, number, number]]> = [
    ['*', [0, 0, 0]],
    ['div', [0, 0, 1]],
    ['div span', [0, 0, 2]],
    ['div > span + a ~ b', [0, 0, 4]],
    ['.a', [0, 1, 0]],
    ['#a', [1, 0, 0]],
    ['#a .b c', [1, 1, 1]],
    ['[type]', [0, 1, 0]],
    ['input[type="text"]', [0, 1, 1]],
    ['a:hover', [0, 1, 1]],
    ['p::before', [0, 0, 2]],
    ['li:nth-child(2)', [0, 1, 1]],
  ];
  for (const [selector, expected] of cases) {
    test(selector, () => assert.deepEqual(specificity(selector), expected));
  }

  test('a # inside an attribute value is text, not an id', () => {
    // The bug: [href="#top"] scored as an id selector and beat every class.
    assert.deepEqual(specificity('a[href="#top"]'), [0, 1, 1]);
    assert.deepEqual(specificity('a[href=".cls"]'), [0, 1, 1]);
    assert.ok(compareSpec(specificity('#real'), specificity('a[href="#top"]')) > 0);
  });

  test(':not() and :is() take their argument, and are not counted themselves', () => {
    // The bug: the argument counted once and the pseudo-class name again.
    assert.deepEqual(specificity(':not(.a)'), [0, 1, 0]);
    assert.deepEqual(specificity('div:not(.a)'), [0, 1, 1]);
    assert.deepEqual(specificity(':not(#a)'), [1, 0, 0]);
    assert.deepEqual(specificity(':not(div)'), [0, 0, 1]);
  });

  test('a functional pseudo-class takes its MOST specific argument, not the sum', () => {
    // The bug these pin: `:is(h1, h2, h3)` scored as three elements, which is
    // enough to flip the cascade against a selector that should have won.
    assert.deepEqual(specificity(':is(.a, .b)'), [0, 1, 0]);
    assert.deepEqual(specificity(':is(h1, h2, h3)'), [0, 0, 1]);
    assert.deepEqual(specificity(':is(#a, .b, div)'), [1, 0, 0]);
    assert.deepEqual(specificity(':not(.a, #b)'), [1, 0, 0]);
    assert.deepEqual(specificity('div:is(.a, .b) span'), [0, 1, 2]);
  });

  test('a non-selector argument is not counted as a selector', () => {
    // "2n+1" is not an element, "en" is not an element.
    assert.deepEqual(specificity('li:nth-child(2n + 1)'), [0, 1, 1]);
    assert.deepEqual(specificity(':lang(en)'), [0, 1, 0]);
    assert.deepEqual(specificity('p:nth-of-type(3)'), [0, 1, 1]);
  });

  test('parentheses inside an argument do not end it early', () => {
    assert.deepEqual(specificity(':not(:is(.a))'), [0, 1, 0]);
    assert.deepEqual(specificity(':is(:not(#a), .b)'), [1, 0, 0]);
  });

  test('an unbalanced selector does not throw or hang', () => {
    assert.deepEqual(specificity(':is(.a'), [0, 0, 0]);
    assert.deepEqual(specificity(':where(.a'), [0, 0, 0]);
    assert.ok(Array.isArray(specificity('[unclosed')));
  });

  test(':where() and everything in it count for nothing', () => {
    assert.deepEqual(specificity(':where(#a, .b, div)'), [0, 0, 0]);
    assert.deepEqual(specificity('div:where(.a)'), [0, 0, 1]);
    assert.deepEqual(specificity(':where(:not(#a)) .b'), [0, 1, 0]);
    // Nested parentheses inside :where must not leave a tail behind.
    assert.deepEqual(specificity(':where(:is(.a, .b)) #c'), [1, 0, 0]);
  });

  test('ordering', () => {
    const more = (a: string, b: string) => compareSpec(specificity(a), specificity(b)) > 0;
    assert.ok(more('#a', '.a.b.c.d'));
    assert.ok(more('.a', 'div span'));
    assert.ok(more('a.b', 'a'));
    assert.equal(compareSpec(specificity('.a'), specificity('[x]')), 0);
  });
});

describe('splitting a selector list', () => {
  test('commas inside parentheses and brackets do not split', () => {
    assert.deepEqual(splitSelectorList('.a, .b'), ['.a', '.b']);
    assert.deepEqual(splitSelectorList(':is(.a, .b), .c'), [':is(.a, .b)', '.c']);
    assert.deepEqual(splitSelectorList('[data-x="a,b"], .c'), ['[data-x="a,b"]', '.c']);
    assert.deepEqual(splitSelectorList('li:nth-child(2n, 1)'), ['li:nth-child(2n, 1)']);
  });

  test('stray whitespace and a trailing comma', () => {
    assert.deepEqual(splitSelectorList('  .a ,  .b  ,'), ['.a', '.b']);
    assert.deepEqual(splitSelectorList(''), []);
  });
});
