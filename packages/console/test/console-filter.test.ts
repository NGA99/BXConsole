/**
 * What the console filter can find.
 *
 * The filter searches a string the panel builds for each row, and a row that
 * draws a word the entry does not carry is a row whose own text cannot be
 * searched for. That is invisible: the word is right there on the screen, so
 * an empty result reads as "no such error" rather than as a filter that never
 * looked. These pin the three rows that write their own prefix.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SerializedValue } from '@bxconsole/protocol';
import type { ConsoleEntry } from '../src/state/session-data';
import { ALL_LEVELS, filterTree, rowText, type Row } from '../src/panels/console/group-tree';

const row = (entry: ConsoleEntry): Row => ({ key: String(entry.seq), entry, repeat: 1 });

const rejected = (reason: SerializedValue): Row =>
  row({ type: 'error.unhandledrejection', seq: 1, ts: 0, reason } as ConsoleEntry);

const threw = (message: string, over: Partial<Extract<ConsoleEntry, { type: 'error.uncaught' }>> = {}): Row =>
  row({ type: 'error.uncaught', seq: 2, ts: 0, message, ...over } as ConsoleEntry);

const found = (rows: Row[], text: string): number => filterTree(rows, ALL_LEVELS, text).length;

describe('a rejection is searchable by the words the row shows', () => {
  test('"in promise" finds it, which is the first thing anybody types', () => {
    /*
     * The row draws `Uncaught (in promise) ` ahead of the reason, and the
     * text used to be the reason alone — so filtering a long log by the one
     * phrase that means "unhandled rejection" returned nothing at all.
     */
    const rows = [rejected({ t: 'string', v: 'the request never settled' })];
    assert.equal(found(rows, 'in promise'), 1);
    assert.equal(found(rows, 'uncaught'), 1);
    assert.equal(found(rows, 'never settled'), 1, 'the reason itself stopped matching');
  });

  test('the two error rows answer the same word the same way', () => {
    // They look alike on screen; one matching `uncaught` while the other did
    // not was the whole defect, and it only worked at all because pages tend
    // to put the word in `message` themselves.
    const rows = [rejected({ t: 'string', v: 'rejected' }), threw('TypeError: x is not a function')];
    assert.equal(found(rows, 'uncaught'), 2);
  });

  test('a filter that excludes them excludes both', () => {
    // `-uncaught` is how you read past the errors, and it has to take the
    // rejection with it or the exclusion looks broken instead.
    const rows = [rejected({ t: 'string', v: 'rejected' }), threw('Uncaught TypeError: x'), row({ type: 'eval.command', seq: 3, ts: 0, expression: 'nap()' } as ConsoleEntry)];
    assert.equal(found(rows, '-uncaught'), 1);
  });
});

describe('the uncaught row says the word once, however the page phrased it', () => {
  test('a message that already opens with Uncaught is not given a second one', () => {
    // The row strips the page's prefix and writes its own, so the text has to
    // do the same — `Uncaught Uncaught TypeError` would match nothing a
    // reader would think to type.
    assert.match(rowText(threw('Uncaught TypeError: x is not a function')), /^Uncaught TypeError: x is not a function$/);
  });

  test('a message with no prefix of its own still matches the word on screen', () => {
    // window.onerror reports the message both ways depending on the browser
    // and how the error was thrown.
    assert.equal(found([threw('TypeError: x is not a function')], 'uncaught'), 1);
  });

  test('the stack and the cause are searchable too, since both are drawn', () => {
    const rows = [
      threw('Error: upload failed', {
        stack: 'Error: upload failed\n    at send (upload.js:12:5)',
        cause: { t: 'error', name: 'TypeError', message: 'socket closed' } as SerializedValue,
      }),
    ];
    assert.equal(found(rows, 'upload.js'), 1);
    assert.equal(found(rows, 'socket closed'), 1, 'the "Caused by" line is on screen and has to be findable');
  });
});

describe('a thrown expression at the prompt', () => {
  test('is findable by the Uncaught the result row draws', () => {
    const rows = [row({ type: 'eval.result', seq: 4, ts: 0, exception: { t: 'string', v: 'boom' } } as ConsoleEntry)];
    assert.equal(found(rows, 'uncaught'), 1);
  });

  test('while a result that came back fine is not', () => {
    // The prefix belongs to the exception branch only; adding it to every
    // result would make `uncaught` match the whole prompt history.
    const ok = row({ type: 'eval.result', seq: 5, ts: 0, result: { t: 'number', v: 42 } } as ConsoleEntry);
    assert.equal(rowText(ok), '42');
    assert.equal(found([ok], 'uncaught'), 0);
  });
});
