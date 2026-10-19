/**
 * Keyboard input replayed from a viewer onto document.activeElement.
 *
 * Synthetic KeyboardEvents reach the page's handlers but trigger no default
 * action, so after dispatching keydown (and only if the page did not
 * preventDefault) we emulate the browser: text insertion via
 * execCommand('insertText') (fires `input`, keeps React's value tracking
 * happy), Backspace/Delete, Enter (newline / submit), caret movement, Tab
 * focus traversal, Space/Enter activation of buttons and links, and page
 * scrolling keys.
 *
 * TODO: IME composition, selection with shift+arrows in contenteditable
 *       across lines, Ctrl/Cmd+Z undo stack.
 */
import { isPrintable, keyAction, type KeyInput, type TargetKind } from './key-actions';

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);

export function applyKey(input: KeyInput): void {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const init: KeyboardEventInit = {
    key: input.key,
    code: input.code,
    altKey: input.altKey,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey,
    shiftKey: input.shiftKey,
    repeat: input.repeat,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  };
  const allowed = target.dispatchEvent(new KeyboardEvent(input.type, init));
  if (input.type !== 'keydown' || !allowed) return;

  if (isPrintable(input)) {
    const kp = target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: input.key.charCodeAt(0) }));
    if (!kp) return;
  }
  defaultAction(target, input);
}

export function applyPaste(text: string): void {
  const target = document.activeElement as HTMLElement | null;
  if (target && isEditable(target)) insertText(target, text);
}

// ------------------------------------------------------------------ defaults

function defaultAction(target: HTMLElement, input: KeyInput): void {
  const action = keyAction(input, kindOf(target));
  switch (action.do) {
    case 'nothing':
      return;
    case 'moveFocus':
      return moveFocus(action.delta);
    case 'blur':
      return target.blur();
    case 'selectAll':
      return selectAll(target);
    case 'insert':
      return insertText(target, action.text);
    case 'delete':
      return deleteText(target, action.dir);
    case 'submit':
      // The change event first: a page that validates on change expects to
      // have seen the final value before it is asked to submit.
      target.dispatchEvent(new Event('change', { bubbles: true }));
      (target as HTMLInputElement).form?.requestSubmit();
      return;
    case 'caret':
      return moveCaret(target, action.key, action.extend);
    case 'click':
      return target.click();
    case 'scroll':
      return window.scrollBy({ top: action.dy, left: action.dx });
    case 'scrollPages':
      return window.scrollBy({ top: action.pages * window.innerHeight });
    case 'scrollTo':
      return window.scrollTo({ top: action.to === 'top' ? 0 : document.documentElement.scrollHeight });
  }
}

/** As much about the focused element as the decision depends on. */
function kindOf(target: HTMLElement): TargetKind {
  return {
    editable: isEditable(target),
    multiline: target instanceof HTMLTextAreaElement || target.isContentEditable,
    formField: target instanceof HTMLInputElement,
    entersAsClick: target.matches('a[href], button, [role="button"], summary, input[type="submit"]'),
    spaceAsClick: target.matches('button, [role="button"], input[type="checkbox"], input[type="radio"], summary'),
  };
}

// ------------------------------------------------------------------ editing


function isEditable(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type) && !el.disabled && !el.readOnly;
  return (el as HTMLElement).isContentEditable === true;
}

function isTextControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

function insertText(target: HTMLElement, text: string): void {
  // execCommand can report success without editing when the document is not
  // focused (background tab), so verify the value actually changed.
  const before = isTextControl(target) ? target.value : null;
  if (tryExec('insertText', text) && (before === null || (target as HTMLInputElement).value !== before)) return;
  if (!isTextControl(target)) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  try {
    target.setRangeText(text, start, end, 'end');
  } catch {
    target.value += text; // input types without selection support (number, email…)
  }
  fireInput(target, 'insertText', text);
}

function deleteText(target: HTMLElement, dir: 'backward' | 'forward'): void {
  const before = isTextControl(target) ? target.value : null;
  if (tryExec(dir === 'backward' ? 'delete' : 'forwardDelete') && (before === null || (target as HTMLInputElement).value !== before)) return;
  if (!isTextControl(target)) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  try {
    if (start !== end) target.setRangeText('', start, end, 'end');
    else if (dir === 'backward' && start > 0) target.setRangeText('', start - 1, start, 'end');
    else if (dir === 'forward') target.setRangeText('', start, start + 1, 'end');
  } catch {
    target.value = target.value.slice(0, -1);
  }
  fireInput(target, dir === 'backward' ? 'deleteContentBackward' : 'deleteContentForward');
}

function tryExec(command: string, value?: string): boolean {
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

function fireInput(target: HTMLElement, inputType: string, data?: string): void {
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: data ?? null }));
}

function selectAll(target: HTMLElement): void {
  if (isTextControl(target)) target.select();
  else document.getSelection()?.selectAllChildren(target);
}

function moveCaret(target: HTMLElement, key: string, extend: boolean): void {
  if (isTextControl(target)) {
    const len = target.value.length;
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    const anchor = extend ? start : null;
    let pos: number;
    switch (key) {
      case 'ArrowLeft':
        pos = extend ? Math.max(0, end - 1) : start === end ? Math.max(0, start - 1) : start;
        break;
      case 'ArrowRight':
        pos = extend ? Math.min(len, end + 1) : start === end ? Math.min(len, end + 1) : end;
        break;
      case 'Home':
        pos = 0;
        break;
      default:
        pos = len;
    }
    try {
      if (extend && anchor !== null) target.setSelectionRange(Math.min(anchor, pos), Math.max(anchor, pos));
      else target.setSelectionRange(pos, pos);
    } catch {
      /* unsupported input type */
    }
    return;
  }
  const sel = document.getSelection() as (Selection & { modify?: (a: string, d: string, g: string) => void }) | null;
  if (!sel?.modify) return;
  const alter = extend ? 'extend' : 'move';
  if (key === 'ArrowLeft') sel.modify(alter, 'left', 'character');
  else if (key === 'ArrowRight') sel.modify(alter, 'right', 'character');
  else if (key === 'Home') sel.modify(alter, 'left', 'lineboundary');
  else sel.modify(alter, 'right', 'lineboundary');
}

function moveFocus(dir: 1 | -1): void {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
    ),
  ).filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && isVisible(el));
  if (!candidates.length) return;
  const idx = candidates.indexOf(document.activeElement as HTMLElement);
  const next = candidates[(idx + dir + candidates.length) % candidates.length]!;
  next.focus();
  if (isTextControl(next)) {
    try {
      next.select();
    } catch {
      /* ignore */
    }
  }
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
