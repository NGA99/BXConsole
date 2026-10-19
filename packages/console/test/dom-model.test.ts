/**
 * The tree the Elements tab walks, fed by the same stream as the mirror.
 *
 * Two of these reproduce faults that were fixed by reasoning rather than by
 * being seen again: a node that ends up its own ancestor (which hung the
 * console tab on any CSS-in-JS page), and a run of siblings arriving in an
 * order that left them reversed.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScreenOp, SnapshotNode } from '@bxconsole/protocol';
import { DomModel } from '../src/state/dom-model';

const el = (id: number, tag: string, children: SnapshotNode[] = [], attrs: Record<string, string> = {}): SnapshotNode => ({
  id,
  t: 'el',
  tag,
  attrs,
  children,
});
const tx = (id: number, text: string): SnapshotNode => ({ id, t: 'tx', text });

/** html > body > the given children */
function page(children: SnapshotNode[]): SnapshotNode[] {
  return [el(1, 'html', [el(2, 'body', children)])];
}

const childTags = (m: DomModel, id: number) => (m.nodes.get(id)?.children ?? []).map((c) => m.nodes.get(c)?.attrs['id'] ?? String(c));

describe('a malformed stream cannot hang the tab', () => {
  test('a node whose child carries its own id does not become its own ancestor', () => {
    // What a <style> filled through insertRule used to produce: the tag has no
    // text child to take an id from, so the synthetic text node was given the
    // style element's own id, and walking up from it never ended.
    const m = new DomModel();
    m.load(page([el(10, 'style', [tx(10, '.a{color:red}')])]));
    // The id collision still costs the node — the text overwrites the element
    // it was nested in — but the walk has to end, and nothing may be its own
    // parent. The agent gives such a text node an id of its own now; this is
    // the guard for a stream that says otherwise anyway.
    assert.equal(m.nodes.get(10)?.parent, null, 'nothing is its own parent');
    const path = m.pathTo(10);
    assert.ok(path.length > 0 && path.length < 50, `path should terminate, got ${path.length}`);
    assert.equal(new Set(path).size, path.length, 'no id appears twice');
  });

  test('pathTo terminates even on a cycle built by later ops', () => {
    const m = new DomModel();
    m.load(page([el(10, 'div', [el(11, 'span')])]));
    // Force the cycle the only way the stream could: re-add 10 under 11.
    m.apply([{ op: 'add', parentId: 11, nextId: null, node: el(10, 'div') }]);
    const path = m.pathTo(10);
    assert.ok(path.length < 50, `path should terminate, got ${path.length}`);
    assert.equal(new Set(path).size, path.length, 'no id appears twice');
  });

  test('ordinary paths are unaffected', () => {
    const m = new DomModel();
    m.load(page([el(10, 'div', [el(11, 'span', [tx(12, 'hi')])])]));
    assert.deepEqual(m.pathTo(12), [1, 2, 10, 11, 12]);
  });
});

describe('inserting among siblings', () => {
  const base = () => {
    const m = new DomModel();
    m.load(page([el(10, 'li', [], { id: 'a' }), el(11, 'li', [], { id: 'b' })]));
    return m;
  };

  test('a run of siblings added last-first lands in document order', () => {
    // The order the agent emits them in, and the only one where each add's
    // `nextId` already exists when it arrives.
    const m = base();
    const ops: ScreenOp[] = [
      { op: 'add', parentId: 2, nextId: null, node: el(22, 'li', [], { id: 'z' }) },
      { op: 'add', parentId: 2, nextId: 22, node: el(21, 'li', [], { id: 'y' }) },
      { op: 'add', parentId: 2, nextId: 21, node: el(20, 'li', [], { id: 'x' }) },
    ];
    m.apply(ops);
    assert.deepEqual(childTags(m, 2), ['a', 'b', 'x', 'y', 'z']);
  });

  test('an insert before an existing sibling goes in front of it', () => {
    const m = base();
    m.apply([{ op: 'add', parentId: 2, nextId: 11, node: el(20, 'li', [], { id: 'mid' }) }]);
    assert.deepEqual(childTags(m, 2), ['a', 'mid', 'b']);
  });

  test('a move is a remove then an add, and lands where it is told', () => {
    const m = base();
    m.apply([
      { op: 'remove', id: 11 },
      { op: 'add', parentId: 2, nextId: 10, node: el(11, 'li', [], { id: 'b' }) },
    ]);
    assert.deepEqual(childTags(m, 2), ['b', 'a']);
  });

  test('an unknown nextId appends rather than throwing', () => {
    const m = base();
    m.apply([{ op: 'add', parentId: 2, nextId: 999, node: el(20, 'li', [], { id: 'end' }) }]);
    assert.deepEqual(childTags(m, 2), ['a', 'b', 'end']);
  });

  test('an add under an unknown parent is dropped, not crashed on', () => {
    const m = base();
    m.apply([{ op: 'add', parentId: 999, nextId: null, node: el(20, 'li') }]);
    assert.deepEqual(childTags(m, 2), ['a', 'b']);
  });
});

describe('search results', () => {
  test('matches come back in document order, however they matched', () => {
    // An element matched by its own text is recorded when the text child is
    // reached, which is after any descendant that matched on its own.
    const m = new DomModel();
    m.load(
      page([
        el(10, 'div', [el(11, 'span', [tx(12, 'needle')], { id: 'inner' }), tx(13, 'needle')], { id: 'outer' }),
        el(14, 'p', [tx(15, 'needle')], { id: 'after' }),
      ]),
    );
    const hits = m.search('needle');
    assert.deepEqual(
      hits.map((id) => m.nodes.get(id)?.attrs['id']),
      ['outer', 'inner', 'after'],
    );
  });

  test('the cap is honoured', () => {
    const m = new DomModel();
    m.load(page(Array.from({ length: 50 }, (_, i) => el(100 + i, 'div', [], { id: `d${i}`, 'data-x': 'needle' }))));
    assert.equal(m.search('needle', 10).length, 10);
  });
});
