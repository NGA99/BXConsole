/**
 * What a key should do, decided apart from doing it.
 *
 * A viewer's keystroke arrives here and ends up changing someone's form. When
 * this is wrong the damage is silent and specific — a Backspace that deletes
 * forwards, a Space that scrolls a page instead of ticking a checkbox, an
 * Enter that submits a form the person was still filling in. None of it looks
 * like a bug in the debugger; it looks like the page misbehaving.
 *
 * So the decision is a pure function of the key and the kind of thing it
 * landed on, and the DOM work it implies lives in screen-keys.ts.
 */
import type { ScreenInput } from '@bxconsole/protocol';

export type KeyInput = Extract<ScreenInput, { kind: 'key' }>;

/** As much about the focused element as the decision depends on. */
export interface TargetKind {
  /** text can be typed into it: a text input, a textarea, or contenteditable */
  editable: boolean;
  /** a newline belongs in it, rather than submitting: textarea or contenteditable */
  multiline: boolean;
  /** an <input>, which submits its form on Enter */
  formField: boolean;
  /** Enter activates it: a link, button, summary or submit input */
  entersAsClick: boolean;
  /** Space activates it: a button, checkbox, radio or summary */
  spaceAsClick: boolean;
}

export type KeyAction =
  | { do: 'nothing' }
  | { do: 'moveFocus'; delta: 1 | -1 }
  | { do: 'blur' }
  | { do: 'selectAll' }
  | { do: 'insert'; text: string }
  | { do: 'delete'; dir: 'backward' | 'forward' }
  | { do: 'submit' }
  | { do: 'caret'; key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'; extend: boolean }
  | { do: 'click' }
  | { do: 'scroll'; dx: number; dy: number }
  | { do: 'scrollPages'; pages: number }
  | { do: 'scrollTo'; to: 'top' | 'bottom' };

/** A key with no modifier that stands for exactly one character. */
export function isPrintable(input: Pick<KeyInput, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return input.key.length === 1 && !input.ctrlKey && !input.metaKey && !input.altKey;
}

/** How far a Page key and Space move: not a whole screen, so context carries over. */
export const PAGE_FRACTION = 0.9;
/** How far an arrow key scrolls when nothing is focused. */
export const ARROW_STEP = 40;

export function keyAction(input: KeyInput, target: TargetKind): KeyAction {
  const mod = input.ctrlKey || input.metaKey;
  const { key } = input;

  // Focus traversal and escape come first: they mean the same thing wherever
  // the keystroke landed.
  if (key === 'Tab') return { do: 'moveFocus', delta: input.shiftKey ? -1 : 1 };
  if (key === 'Escape') return { do: 'blur' };

  return target.editable ? inEditable(input, target, mod) : onPage(input, target);
}

function inEditable(input: KeyInput, target: TargetKind, mod: boolean): KeyAction {
  const { key } = input;
  if (mod && key.toLowerCase() === 'a') return { do: 'selectAll' };
  // Copy, cut and undo are the browser's, and emulating them badly is worse
  // than leaving them alone.
  if (mod) return { do: 'nothing' };

  switch (key) {
    case 'Backspace':
      return { do: 'delete', dir: 'backward' };
    case 'Delete':
      return { do: 'delete', dir: 'forward' };
    case 'Enter':
      if (target.multiline) return { do: 'insert', text: '\n' };
      return target.formField ? { do: 'submit' } : { do: 'nothing' };
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'Home':
    case 'End':
      return { do: 'caret', key, extend: input.shiftKey };
    default:
      return isPrintable(input) ? { do: 'insert', text: key } : { do: 'nothing' };
  }
}

function onPage(input: KeyInput, target: TargetKind): KeyAction {
  switch (input.key) {
    case 'Enter':
      return target.entersAsClick ? { do: 'click' } : { do: 'nothing' };
    case ' ':
      if (target.spaceAsClick) return { do: 'click' };
      return { do: 'scrollPages', pages: input.shiftKey ? -PAGE_FRACTION : PAGE_FRACTION };
    case 'ArrowDown':
      return { do: 'scroll', dx: 0, dy: ARROW_STEP };
    case 'ArrowUp':
      return { do: 'scroll', dx: 0, dy: -ARROW_STEP };
    case 'ArrowRight':
      return { do: 'scroll', dx: ARROW_STEP, dy: 0 };
    case 'ArrowLeft':
      return { do: 'scroll', dx: -ARROW_STEP, dy: 0 };
    case 'PageDown':
      return { do: 'scrollPages', pages: PAGE_FRACTION };
    case 'PageUp':
      return { do: 'scrollPages', pages: -PAGE_FRACTION };
    case 'Home':
      return { do: 'scrollTo', to: 'top' };
    case 'End':
      return { do: 'scrollTo', to: 'bottom' };
    default:
      return { do: 'nothing' };
  }
}
