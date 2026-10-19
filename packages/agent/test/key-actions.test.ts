/**
 * What a keystroke sent from a viewer does to the page it lands on.
 *
 * Every failure here is quiet and specific: a Backspace that deletes
 * forwards, a Space that scrolls past a checkbox instead of ticking it, an
 * Enter that submits a form someone was still filling in. None of it reads as
 * a bug in the debugger — it reads as the page misbehaving, which is the one
 * conclusion a debugger must never cause.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ARROW_STEP, PAGE_FRACTION, isPrintable, keyAction, type KeyInput, type TargetKind } from '../src/hooks/key-actions';

const key = (over: Partial<KeyInput> & { key: string }): KeyInput =>
  ({ kind: 'key', type: 'keydown', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...over }) as KeyInput;

const NOWHERE: TargetKind = { editable: false, multiline: false, formField: false, entersAsClick: false, spaceAsClick: false };
const TEXT_INPUT: TargetKind = { editable: true, multiline: false, formField: true, entersAsClick: false, spaceAsClick: false };
const TEXTAREA: TargetKind = { editable: true, multiline: true, formField: false, entersAsClick: false, spaceAsClick: false };
const RICH_TEXT: TargetKind = { editable: true, multiline: true, formField: false, entersAsClick: false, spaceAsClick: false };
const LINK: TargetKind = { ...NOWHERE, entersAsClick: true };
const CHECKBOX: TargetKind = { ...NOWHERE, spaceAsClick: true };
const BUTTON: TargetKind = { ...NOWHERE, entersAsClick: true, spaceAsClick: true };

describe('wherever the keystroke lands', () => {
  test('Tab moves focus, and Shift+Tab moves it back', () => {
    for (const where of [NOWHERE, TEXT_INPUT, BUTTON]) {
      assert.deepEqual(keyAction(key({ key: 'Tab' }), where), { do: 'moveFocus', delta: 1 });
      assert.deepEqual(keyAction(key({ key: 'Tab', shiftKey: true }), where), { do: 'moveFocus', delta: -1 });
    }
  });

  test('Escape gives up focus rather than typing an escape', () => {
    assert.deepEqual(keyAction(key({ key: 'Escape' }), TEXT_INPUT), { do: 'blur' });
  });
});

describe('typing into something editable', () => {
  test('a printable key inserts exactly that character', () => {
    assert.deepEqual(keyAction(key({ key: 'a' }), TEXT_INPUT), { do: 'insert', text: 'a' });
    assert.deepEqual(keyAction(key({ key: ' ' }), TEXT_INPUT), { do: 'insert', text: ' ' }, 'a space in a field is a space, not a scroll');
    assert.deepEqual(keyAction(key({ key: 'é' }), TEXT_INPUT), { do: 'insert', text: 'é' });
    assert.deepEqual(keyAction(key({ key: 'A', shiftKey: true }), TEXT_INPUT), { do: 'insert', text: 'A' });
  });

  test('Backspace deletes backwards and Delete forwards, never the other way', () => {
    assert.deepEqual(keyAction(key({ key: 'Backspace' }), TEXT_INPUT), { do: 'delete', dir: 'backward' });
    assert.deepEqual(keyAction(key({ key: 'Delete' }), TEXT_INPUT), { do: 'delete', dir: 'forward' });
  });

  test('a named key is not typed as its name', () => {
    // 'F5' is five characters; inserting it would put "F5" in the field.
    for (const k of ['F5', 'Shift', 'Control', 'Alt', 'CapsLock', 'Insert', 'PageDown', 'ArrowUp', 'ArrowDown']) {
      assert.deepEqual(keyAction(key({ key: k }), TEXT_INPUT), { do: 'nothing' }, k);
    }
  });

  test('Enter makes a newline where one belongs and submits where it does not', () => {
    assert.deepEqual(keyAction(key({ key: 'Enter' }), TEXTAREA), { do: 'insert', text: '\n' });
    assert.deepEqual(keyAction(key({ key: 'Enter' }), RICH_TEXT), { do: 'insert', text: '\n' });
    assert.deepEqual(keyAction(key({ key: 'Enter' }), TEXT_INPUT), { do: 'submit' });
  });

  test('Enter in something editable that is neither does nothing rather than guessing', () => {
    const odd: TargetKind = { editable: true, multiline: false, formField: false, entersAsClick: false, spaceAsClick: false };
    assert.deepEqual(keyAction(key({ key: 'Enter' }), odd), { do: 'nothing' });
  });

  test('the caret keys move the caret, and Shift extends the selection', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End'] as const) {
      assert.deepEqual(keyAction(key({ key: k }), TEXT_INPUT), { do: 'caret', key: k, extend: false });
      assert.deepEqual(keyAction(key({ key: k, shiftKey: true }), TEXT_INPUT), { do: 'caret', key: k, extend: true });
    }
  });

  test('Home and End move the caret in a field, not the page', () => {
    // The same two keys scroll the document when nothing is focused, which is
    // exactly the confusion worth pinning.
    assert.equal(keyAction(key({ key: 'Home' }), TEXT_INPUT).do, 'caret');
    assert.equal(keyAction(key({ key: 'Home' }), NOWHERE).do, 'scrollTo');
  });
});

describe('modified keys in a field', () => {
  test('select-all is honoured on either platform', () => {
    assert.deepEqual(keyAction(key({ key: 'a', ctrlKey: true }), TEXT_INPUT), { do: 'selectAll' });
    assert.deepEqual(keyAction(key({ key: 'a', metaKey: true }), TEXT_INPUT), { do: 'selectAll' });
    assert.deepEqual(keyAction(key({ key: 'A', metaKey: true, shiftKey: true }), TEXT_INPUT), { do: 'selectAll' }, 'caps should not matter');
  });

  test('copy, cut, paste and undo are left to the browser rather than emulated badly', () => {
    for (const k of ['c', 'x', 'v', 'z', 'y', 's']) {
      assert.deepEqual(keyAction(key({ key: k, metaKey: true }), TEXT_INPUT), { do: 'nothing' }, k);
    }
  });

  test('a modified key never arrives as a typed character', () => {
    assert.equal(isPrintable(key({ key: 'b', ctrlKey: true })), false);
    assert.equal(isPrintable(key({ key: 'b', altKey: true })), false);
    assert.equal(isPrintable(key({ key: 'b', metaKey: true })), false);
    assert.equal(isPrintable(key({ key: 'b', shiftKey: true })), true, 'shift is how capitals are typed');
  });
});

describe('keys on the page itself', () => {
  test('Enter activates what Enter activates, and nothing else', () => {
    assert.deepEqual(keyAction(key({ key: 'Enter' }), LINK), { do: 'click' });
    assert.deepEqual(keyAction(key({ key: 'Enter' }), BUTTON), { do: 'click' });
    assert.deepEqual(keyAction(key({ key: 'Enter' }), CHECKBOX), { do: 'nothing' }, 'Enter does not tick a checkbox');
    assert.deepEqual(keyAction(key({ key: 'Enter' }), NOWHERE), { do: 'nothing' });
  });

  test('Space ticks a checkbox instead of scrolling past it', () => {
    assert.deepEqual(keyAction(key({ key: ' ' }), CHECKBOX), { do: 'click' });
    assert.deepEqual(keyAction(key({ key: ' ' }), BUTTON), { do: 'click' });
    assert.deepEqual(keyAction(key({ key: ' ' }), LINK), { do: 'scrollPages', pages: PAGE_FRACTION }, 'a link is not activated by Space');
  });

  test('Space scrolls a page down, and Shift+Space back up', () => {
    assert.deepEqual(keyAction(key({ key: ' ' }), NOWHERE), { do: 'scrollPages', pages: PAGE_FRACTION });
    assert.deepEqual(keyAction(key({ key: ' ', shiftKey: true }), NOWHERE), { do: 'scrollPages', pages: -PAGE_FRACTION });
  });

  test('a page scroll leaves some of the last screen behind', () => {
    assert.ok(PAGE_FRACTION < 1, 'scrolling a whole viewport loses the line you were reading');
    assert.ok(PAGE_FRACTION > 0.5);
  });

  test('the arrows scroll in the direction they point', () => {
    assert.deepEqual(keyAction(key({ key: 'ArrowDown' }), NOWHERE), { do: 'scroll', dx: 0, dy: ARROW_STEP });
    assert.deepEqual(keyAction(key({ key: 'ArrowUp' }), NOWHERE), { do: 'scroll', dx: 0, dy: -ARROW_STEP });
    assert.deepEqual(keyAction(key({ key: 'ArrowRight' }), NOWHERE), { do: 'scroll', dx: ARROW_STEP, dy: 0 });
    assert.deepEqual(keyAction(key({ key: 'ArrowLeft' }), NOWHERE), { do: 'scroll', dx: -ARROW_STEP, dy: 0 });
  });

  test('PageUp and PageDown, Home and End', () => {
    assert.deepEqual(keyAction(key({ key: 'PageDown' }), NOWHERE), { do: 'scrollPages', pages: PAGE_FRACTION });
    assert.deepEqual(keyAction(key({ key: 'PageUp' }), NOWHERE), { do: 'scrollPages', pages: -PAGE_FRACTION });
    assert.deepEqual(keyAction(key({ key: 'Home' }), NOWHERE), { do: 'scrollTo', to: 'top' });
    assert.deepEqual(keyAction(key({ key: 'End' }), NOWHERE), { do: 'scrollTo', to: 'bottom' });
  });

  test('an ordinary letter with nothing focused changes nothing', () => {
    assert.deepEqual(keyAction(key({ key: 'q' }), NOWHERE), { do: 'nothing' });
  });
});

describe('a disabled or read-only field is not editable', () => {
  test('typing into one scrolls the page instead of silently editing it', () => {
    // isEditable() in screen-keys returns false for these, so they arrive here
    // as NOWHERE — the point being that the keystroke must not edit anything.
    assert.deepEqual(keyAction(key({ key: 'a' }), NOWHERE), { do: 'nothing' });
    assert.deepEqual(keyAction(key({ key: 'Backspace' }), NOWHERE), { do: 'nothing' });
  });
});
