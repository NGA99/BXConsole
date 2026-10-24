import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEnterSubmit } from '../src/devtools-ui/enter-key';

/** A keydown with the fields this reads, defaulting to a plain committed Enter. */
const key = (o: Partial<Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>> = {}) =>
  ({ key: 'Enter', isComposing: false, keyCode: 13, ...o }) as KeyboardEvent;

test('a plain Enter submits', () => {
  assert.equal(isEnterSubmit(key()), true);
});

test('the Enter that commits an IME composition does not submit', () => {
  // This is the one the bug fired on: the last Korean jamo was still being
  // composed, so this Enter only finishes the word.
  assert.equal(isEnterSubmit(key({ isComposing: true })), false);
});

test('the legacy 229 keydown does not submit either', () => {
  // Some IMEs leave isComposing unset and report the consumed key as 229.
  assert.equal(isEnterSubmit(key({ keyCode: 229, isComposing: false })), false);
});

test('a key other than Enter never submits', () => {
  assert.equal(isEnterSubmit(key({ key: 'a' })), false);
});
