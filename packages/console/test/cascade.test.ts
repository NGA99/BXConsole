/**
 * Which declaration the Styles pane shows as winning, and which it strikes
 * out. Wrong here does not look like a bug in the console — it looks like a
 * bug in the page being debugged, which is the worst way to be wrong.
 *
 * The agent hands the rules over already sorted into cascade order (most
 * specific first, later rules before earlier ones at equal specificity), so
 * what is pinned here is what the console does with that order.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Declaration, ElementStyles, MatchedRule } from '@bxconsole/protocol';
import { computeWinners, isWinner } from '../src/panels/elements/cascade';

const d = (name: string, value: string, important = false): Declaration => ({ name, value, important });

const rule = (selector: string, decls: Declaration[], spec: [number, number, number] = [0, 1, 0], order = 0): MatchedRule => ({
  selector,
  source: 'sheet.css',
  declarations: decls,
  specificity: spec,
  order,
});

const styles = (over: Partial<ElementStyles>): ElementStyles => ({
  inline: [],
  rules: [],
  inherited: [],
  computed: [],
  box: { margin: [0, 0, 0, 0], border: [0, 0, 0, 0], padding: [0, 0, 0, 0], width: 0, height: 0 },
  unreadableSheets: 0,
  ...over,
});

/** The block and index the pane would draw un-struck for `name`. */
const winnerOf = (s: ElementStyles, name: string) => computeWinners(s).get(name);

describe('the cascade', () => {
  test('inline beats a rule, and a rule beats inherited', () => {
    const s = styles({
      inline: [d('color', 'red')],
      rules: [rule('.a', [d('color', 'green')])],
      inherited: [{ from: 'body', fromId: null, inline: [], rules: [rule('body', [d('color', 'blue')])] }],
    });
    assert.deepEqual(winnerOf(s, 'color'), { block: 'inline', index: 0 });
  });

  test('earlier in the agent order wins, because that order is the cascade', () => {
    const s = styles({ rules: [rule('#a', [d('color', 'green')], [1, 0, 0]), rule('.a', [d('color', 'red')])] });
    assert.deepEqual(winnerOf(s, 'color'), { block: '0', index: 0 });
  });

  test('!important beats anything without it, wherever it sits', () => {
    const s = styles({
      inline: [d('color', 'red')],
      rules: [rule('.a', [d('color', 'green', true)])],
    });
    assert.deepEqual(winnerOf(s, 'color'), { block: '0', index: 0 });
  });

  test('among important declarations the first in cascade order wins', () => {
    const s = styles({
      rules: [rule('#a', [d('color', 'green', true)], [1, 0, 0]), rule('.a', [d('color', 'red', true)])],
    });
    assert.deepEqual(winnerOf(s, 'color'), { block: '0', index: 0 });
  });

  test('within one block the LAST declaration of a property wins', () => {
    // CSS takes the last; the pane used to show the first un-struck.
    const s = styles({ rules: [rule('.a', [d('color', 'red'), d('color', 'blue')])] });
    assert.deepEqual(winnerOf(s, 'color'), { block: '0', index: 1 });
    const winners = computeWinners(s);
    assert.ok(!isWinner(winners, '0', 0, 'color'), 'the earlier copy is struck out');
    assert.ok(isWinner(winners, '0', 1, 'color'));
  });

  test('a repeated property inline follows the same rule', () => {
    const s = styles({ inline: [d('color', 'red'), d('color', 'blue')] });
    assert.deepEqual(winnerOf(s, 'color'), { block: 'inline', index: 1 });
  });

  test('inherited applies only to properties the element does not set itself', () => {
    const s = styles({
      rules: [rule('.a', [d('color', 'green')])],
      inherited: [{ from: 'body', fromId: null, inline: [], rules: [rule('body', [d('color', 'blue'), d('font-size', '12px')])] }],
    });
    assert.deepEqual(winnerOf(s, 'color'), { block: '0', index: 0 });
    assert.deepEqual(winnerOf(s, 'font-size'), { block: 'inherited:0:0', index: 1 });
  });

  test('an inherited !important does not beat the element own declaration', () => {
    // Inheritance only applies where nothing matched the element itself.
    const s = styles({
      rules: [rule('.a', [d('color', 'green')])],
      inherited: [{ from: 'body', fromId: null, inline: [d('color', 'blue', true)], rules: [] }],
    });
    assert.deepEqual(winnerOf(s, 'color'), { block: '0', index: 0 });
  });

  test('properties are independent of one another', () => {
    const s = styles({
      inline: [d('color', 'red')],
      rules: [rule('.a', [d('color', 'green'), d('margin', '0')])],
    });
    assert.deepEqual(winnerOf(s, 'color'), { block: 'inline', index: 0 });
    assert.deepEqual(winnerOf(s, 'margin'), { block: '0', index: 1 });
  });

  test('a custom property cascades like any other', () => {
    const s = styles({
      rules: [rule('.a', [d('--brand', 'red')]), rule('.b', [d('--brand', 'blue')], [0, 1, 0], 1)],
    });
    assert.deepEqual(winnerOf(s, '--brand'), { block: '0', index: 0 });
  });
});
