/**
 * What the recording keeps of what someone typed.
 *
 * A replay is read to find out what happened in a browser that is not ours,
 * and the fields a person fills in are the closest thing it has to their
 * intent. This used to bullet out password fields — quietly, with no comment
 * saying why and no test either way — which left the one field that matters
 * most as a row of dots in the middle of a run that keeps Authorization
 * headers and logged tokens verbatim. These tests are here so that choice
 * cannot be made again by accident.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { inputState } from '../src/hooks/screen';

/*
 * `inputState` asks `el instanceof HTMLInputElement`, so the constructor has
 * to exist and the fakes have to be instances of it. Textareas and selects
 * are deliberately NOT instances: that is how the real code tells them apart.
 */
class FakeInput {
  type: string;
  value: string;
  checked: boolean;
  constructor(type: string, value = '', checked = false) {
    this.type = type;
    this.value = value;
    this.checked = checked;
  }
}

const asInput = (type: string, value = '', checked = false) =>
  new FakeInput(type, value, checked) as unknown as HTMLInputElement;
/** Not an HTMLInputElement, which is the whole point of these two. */
const asOther = (value: string) => ({ value }) as unknown as HTMLTextAreaElement;

beforeEach(() => {
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = FakeInput;
});
afterEach(() => {
  delete (globalThis as unknown as { HTMLInputElement?: unknown }).HTMLInputElement;
});

describe('what an input contributes to the recording', () => {
  test('a password field records what was typed, not a row of dots', () => {
    assert.deepEqual(inputState(asInput('password', 'hunter2')), { value: 'hunter2' });
    assert.deepEqual(inputState(asInput('password', 'p@ss w/ spaces & symbols')), { value: 'p@ss w/ spaces & symbols' });
  });

  test('no masking character reaches the recording, for any field', () => {
    // The guard that would have caught the old behaviour whatever glyph it used.
    for (const type of ['password', 'text', 'email', 'tel', 'search', 'url', 'number']) {
      const { value } = inputState(asInput(type, 'secret-value-123'));
      assert.equal(value, 'secret-value-123', type);
      assert.ok(!/[\u2022\u25CF\u002A\u00B7]/.test(value ?? ''), `${type} came back masked: ${value}`);
    }
  });

  test('an empty password is an empty string, not a missing value', () => {
    // undefined would read as "this field has no value to record", which is a
    // different claim from "they cleared it".
    assert.deepEqual(inputState(asInput('password', '')), { value: '' });
  });

  test('a long password is not truncated here', () => {
    const long = 'x'.repeat(5000);
    assert.equal(inputState(asInput('password', long)).value, long);
  });

  test('ordinary fields are unchanged', () => {
    assert.deepEqual(inputState(asInput('text', 'plain')), { value: 'plain' });
    assert.deepEqual(inputState(asInput('hidden', 'csrf-token-abc')), { value: 'csrf-token-abc' });
  });

  test('checkboxes and radios record their state and no value', () => {
    assert.deepEqual(inputState(asInput('checkbox', 'on', true)), { checked: true });
    assert.deepEqual(inputState(asInput('checkbox', 'on', false)), { checked: false });
    assert.deepEqual(inputState(asInput('radio', 'choice', true)), { checked: true });
  });

  test('a file input records nothing, because it has nothing true to record', () => {
    // `value` is a path the browser invents (C:\fakepath\…) and the files
    // cannot be read from here, so neither field would be the truth.
    assert.deepEqual(inputState(asInput('file', 'C:\\fakepath\\secrets.pdf')), {});
  });

  test('textareas and selects are not inputs and keep their value', () => {
    assert.deepEqual(inputState(asOther('typed into a textarea')), { value: 'typed into a textarea' });
    assert.deepEqual(inputState(asOther('chosen-option')), { value: 'chosen-option' });
  });
});
