import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain } from '../src/devtools-ui/plain-text';

test('a reversing character cannot make a name read as another one', () => {
  // Drawn as "acmehostile-sessions" in every browser.
  const spoof = 'acme‮noisses-elitsoh‬';
  const shown = plain(spoof);
  assert.ok(!/[‪-‮]/.test(shown), 'the formatting characters are gone');
  assert.ok(shown.includes('noisses-elitsoh'), 'what is left is the string as it is stored');
});

test('each one is marked rather than dropped', () => {
  // Dropping them would let two different names render identically, which is
  // the thing being defended against.
  assert.equal(plain('a‮b'), 'a�b');
  assert.equal(plain('a‮b').length, 'a‮b'.length);
});

test('every explicit direction control, and only those', () => {
  for (const c of ['؜', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']) {
    assert.equal(plain(`x${c}y`), 'x�y', `U+${c.codePointAt(0)!.toString(16)} is removed`);
  }
});

test('a page written in Hebrew or Arabic is left as it is', () => {
  // These letters carry direction on their own, without any control
  // character; a console that mangled them would be the worse tool.
  for (const s of ['דף הבית', 'الصفحة الرئيسية', 'ホーム', 'Ínicio']) assert.equal(plain(s), s);
});

test('ordinary titles and urls are untouched', () => {
  assert.equal(plain('Checkout — payment'), 'Checkout — payment');
  assert.equal(plain('https://intranet.corp.example/a?b=c#d'), 'https://intranet.corp.example/a?b=c#d');
  assert.equal(plain(''), '');
});

test('a name the page never sent stays missing', () => {
  // The call sites pass `name ?? title`, which is undefined often enough that
  // turning it into "undefined" would show up on screen.
  assert.equal(plain(null), null);
  assert.equal(plain(undefined), undefined);
});
