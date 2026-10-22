import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableNode, usableOps, usableSnapshot } from '../src/panels/screen/op-guard';
import { DomModel } from '../src/state/dom-model';
import { ScreenReplayer } from '../src/panels/screen/replay';
import { listOfStrings, usableProperties, usableSourceText, usableSources, usableStyles } from '../src/transport/reply-guard';
import { headerCount, headerOf, headerPairs, textOf } from '../src/panels/network/field-guard';
import { describeError } from '../src/devtools-ui/error-text';
import { isNavigableAttr } from '../src/panels/screen/mirror';
import { isLinkableUrl, isScriptUrl, safeHref } from '../src/devtools-ui/safe-url';
import type { SerializedValue } from '@bxconsole/protocol';
import { formatValue } from '../src/panels/console/format';
import { buildItems } from '../src/panels/history/items';
import { searchEntries } from '../src/panels/network/search';

/*
 * Every value below is one a debugged page can put on the socket. The types
 * say otherwise, which is the point: TypeScript is not there when the message
 * arrives, and these guards are what stands between a wrong type and a
 * panel that throws out of render.
 */

// ----------------------------------------------------------- the screen stream

test('the mirror treats every navigable attribute as navigable', () => {
  /*
   * The scheme check itself lives in safe-url (and is tested there); this is
   * the list of attributes it is applied to. `xlink:href` is the SVG spelling
   * of href and `formaction` is the submit button's override of its form's
   * action — both were observed landing in the mirrored tree while the check
   * named only href, src and action.
   */
  for (const name of ['href', 'src', 'action', 'formaction', 'xlink:href', 'HREF', 'XLink:Href', 'FormAction']) {
    assert.equal(isNavigableAttr(name), true, name);
  }
  for (const name of ['class', 'id', 'style', 'srcset', 'data-href', 'hrefs', 'onclick']) {
    assert.equal(isNavigableAttr(name), false, name);
  }
});

test('a node without a usable id or type is dropped', () => {
  assert.equal(usableNode(null), null);
  assert.equal(usableNode({ t: 'el', tag: 'div' }), null, 'no id');
  assert.equal(usableNode({ id: 'one', t: 'el', tag: 'div' }), null, 'id is not a number');
  assert.equal(usableNode({ id: 1, t: 'nosuchtype' }), null);
  assert.equal(usableNode({ id: NaN, t: 'tx', text: 'x' }), null, 'NaN is not an id');
});

test('an unusual but real tag name is carried, not dropped', () => {
  /*
   * This guard used to predict what `document.createElement` accepts, and was
   * wrong both ways: it dropped `<x-日本>` and `<ÉlémentCustom>`, which are
   * ordinary custom elements, and fuzzing the predicate against the real
   * createElement over four thousand names disagreed two hundred times the
   * other way. Only the mirror needs a name the DOM will take, so the refusal
   * is caught there instead; the Elements model keeps the tree as plain data
   * and never calls createElement. Here a tag only has to be a string.
   */
  for (const tag of ['div', 'my-element', 'svg', 'xlink:use', 'A_b.c-d', 'x-日本', 'ÉlémentCustom', 'emoji-🎉-el', 'clipPath']) {
    const node = usableNode({ id: 1, t: 'el', tag, attrs: {}, children: [] });
    assert.ok(node, tag);
    assert.equal(node.t === 'el' ? node.tag : null, tag, `${tag} kept verbatim`);
  }
  // an element with no tag at all is the one that cannot be carried
  assert.equal(usableNode({ id: 1, t: 'el', tag: '', attrs: {}, children: [] }), null);
  assert.equal(usableNode({ id: 1, t: 'el', tag: 7, attrs: {}, children: [] }), null);
});

test('a node whose attrs and children are not collections still builds', () => {
  const node = usableNode({ id: 1, t: 'el', tag: 'div', attrs: null, children: null });
  assert.deepEqual(node, { id: 1, t: 'el', tag: 'div', attrs: {}, children: [] });
});

test('attribute values are coerced and impossible names dropped', () => {
  const node = usableNode({
    id: 1,
    t: 'el',
    tag: 'div',
    attrs: { ok: 7, alsoOk: null, 'bad name': 'x', 'bad"name': 'y', '': 'z' },
    children: [],
  });
  assert.deepEqual(node?.t === 'el' ? node.attrs : null, { ok: '7', alsoOk: '' });
});

test('text and comment nodes take any text as a string', () => {
  assert.deepEqual(usableNode({ id: 2, t: 'tx', text: 42 }), { id: 2, t: 'tx', text: '42' });
  assert.deepEqual(usableNode({ id: 3, t: 'cm', text: null }), { id: 3, t: 'cm', text: '' });
  assert.deepEqual(usableNode({ id: 4, t: 'doctype', name: null }), { id: 4, t: 'doctype', name: 'html' });
});

test('a snapshot that is not an array is empty, and bad children are skipped', () => {
  assert.deepEqual(usableSnapshot(null), []);
  assert.deepEqual(usableSnapshot('tree'), []);
  const node = usableNode({ id: 1, t: 'el', tag: 'div', attrs: {}, children: [{ id: 2, t: 'tx', text: 'keep' }, null, { t: 'tx' }] });
  assert.equal(node?.t === 'el' ? node.children.length : -1, 1);
});

test('ops that cannot be applied are dropped, and the rest of the batch survives', () => {
  const ops = usableOps([
    { op: 'attr', id: 1, name: 'data-x', value: 'keep' },
    { op: 'attr', id: 1, name: null, value: 'x' },
    { op: 'attr', id: 'one', name: 'data-y', value: 'x' },
    { op: 'attr', id: 1, name: 'bad name', value: 'x' },
    { op: 'text', id: 2, text: null },
    { op: 'add', parentId: 3, nextId: null, node: { id: 4, t: 'el', tag: '', attrs: null, children: null } },
    { op: 'add', parentId: 3, nextId: null, node: { id: 5, t: 'tx', text: 'added' } },
    { op: 'remove', id: 999999 },
    { op: 'scroll', id: null, x: 'left', y: NaN },
    { op: 'scroll', id: null, x: 0, y: 10 },
    { op: 'nosuchop', id: 1 },
    null,
    'not-an-op',
  ]);
  assert.deepEqual(
    ops.map((o) => o.op),
    ['attr', 'text', 'add', 'remove', 'scroll'],
  );
  assert.equal(usableOps(null).length, 0);
  assert.equal(usableOps('batch').length, 0);
});

test('an attr op keeps a null value, which is how a removal is said', () => {
  const [op] = usableOps([{ op: 'attr', id: 1, name: 'hidden', value: null }]);
  assert.equal(op?.op === 'attr' ? op.value : 'missing', null);
});

// ------------------------------------------------------------- agent replies

test('element styles survive every field arriving as the wrong type', () => {
  const styles = usableStyles({
    inline: null,
    rules: 'not-an-array',
    inherited: [{ from: 7, fromId: 'x', inline: null, rules: null }],
    computed: [null, 'not-a-pair', [1, 2], ['color', 'red']],
    box: { margin: null, border: 'thin', padding: [1], width: 'wide', height: null },
    unreadableSheets: 'many',
  });
  assert.ok(styles);
  assert.deepEqual(styles.inline, []);
  assert.deepEqual(styles.rules, []);
  assert.equal(styles.inherited[0]?.from, '7');
  assert.equal(styles.inherited[0]?.fromId, null);
  // the pairs the Computed pane destructures are always pairs of strings
  assert.deepEqual(styles.computed, [['1', '2'], ['color', 'red']]);
  assert.deepEqual(styles.box.margin, [0, 0, 0, 0]);
  assert.deepEqual(styles.box.padding, [1, 0, 0, 0]);
  assert.equal(styles.box.width, 0);
  assert.equal(styles.unreadableSheets, 0);
  assert.equal(usableStyles(null), null);
});

test('a matched rule always has a specificity and an order to sort on', () => {
  const styles = usableStyles({ rules: [{ selector: 'a', source: 'x', declarations: [{ name: 'c', value: 'red' }] }] });
  const rule = styles?.rules[0];
  assert.deepEqual(rule?.specificity, [0, 0, 0]);
  assert.equal(rule?.order, 0);
  assert.equal(rule?.declarations[0]?.important, false);
});

test('a source list drops what is not an entry and coerces the rest', () => {
  const sources = usableSources([
    { url: null, kind: 7, inline: 'yes', label: {} },
    { url: 12345, kind: 'script', inline: false, label: null },
    'not-even-an-object',
    null,
    { url: 'https://x/a.js', kind: 'stylesheet', inline: true, label: 'a.js' },
  ]);
  assert.equal(sources.length, 3);
  assert.equal(sources[0]?.url, '');
  assert.equal(sources[0]?.kind, 'script', 'an unknown kind falls back to script');
  assert.equal(sources[0]?.inline, true);
  assert.equal(sources[1]?.url, '12345');
  assert.equal(sources[2]?.kind, 'stylesheet');
  assert.deepEqual(usableSources(null), []);
});

test('source text keeps null as null and turns anything else into a string', () => {
  assert.equal(usableSourceText({ url: null, text: 42, mimeType: 7 })?.text, '42');
  assert.equal(usableSourceText({ url: 'x', text: null })?.text, null);
  assert.equal(usableSourceText({ url: 'x' })?.text, null);
  assert.equal(usableSourceText('nope'), null);
});

test('object properties drop the unusable and keep null as "collected"', () => {
  assert.equal(usableProperties(null), null, 'null means the object is gone, not that it has none');
  const props = usableProperties([
    null,
    'not-an-object',
    { name: null, value: null },
    { name: 7, value: { t: 'array', length: 'x', preview: null } },
    { name: 'ok', value: { t: 'string', v: 'v' }, enumerable: false },
  ]);
  assert.equal(props?.length, 3);
  assert.equal(props?.[0]?.name, '');
  assert.equal(props?.[0]?.value.t, 'undefined', 'a value with no type tag cannot reach the switch');
  assert.equal(props?.[1]?.name, '7');
  assert.equal(props?.[2]?.enumerable, false);
});

test('completion names are strings or they are not offered', () => {
  assert.deepEqual(listOfStrings([null, 42, { not: 'a name' }, 'real']), ['real']);
  assert.deepEqual(listOfStrings('names'), []);
  assert.deepEqual(listOfStrings(undefined), []);
});

// ------------------------------------------------------------ network fields

test('a header map that is not an object reads as no headers', () => {
  for (const v of [null, undefined, 'nope', 7, []]) {
    assert.deepEqual(headerPairs(v), [], String(v));
    assert.equal(headerCount(v), 0);
    assert.equal(headerOf(v, 'content-type'), '');
  }
});

test('header values are coerced and looked up case-insensitively', () => {
  const h = { 'Content-Type': 9, 'x-a': null };
  assert.deepEqual(headerPairs(h), [['Content-Type', '9'], ['x-a', '']]);
  assert.equal(headerOf(h, 'content-type'), '9');
  assert.equal(headerOf(h, 'CONTENT-TYPE'), '9');
  assert.equal(headerOf(h, 'missing'), '');
  assert.equal(headerCount(h), 2);
});

test('textOf gives a string for anything a field can hold', () => {
  assert.equal(textOf('a'), 'a');
  assert.equal(textOf(7), '7');
  assert.equal(textOf(null), '');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf({}), '[object Object]');
});

// --------------------------------------------------------- the boundary's text

test('an error is described in one readable line whatever was thrown', () => {
  assert.equal(describeError(new TypeError('x.split is not a function')), 'TypeError: x.split is not a function');
  assert.equal(describeError('a thrown string'), 'a thrown string');
  assert.equal(describeError({ message: 'plain object' }), 'plain object');
  assert.equal(describeError({ name: 'Weird', message: 'both' }), 'Weird: both');
  assert.equal(describeError(null), 'null was thrown.');
  assert.equal(describeError(undefined), 'An error with no message.');
  assert.equal(describeError(new Error('')), 'An error with no message.', 'a plain Error with nothing in it');
  assert.equal(describeError(Object.assign(new Error(''), { name: 'RelayDown' })), 'RelayDown', 'a chosen name is worth printing alone');
  assert.equal(describeError(7), '7 was thrown.');
  assert.match(describeError({}), /was thrown\.$/);
});

test('a description is one line and bounded, so the boundary stays readable', () => {
  const long = describeError(new Error('a'.repeat(500)));
  assert.ok(long.length <= 212, `got ${long.length}`);
  assert.ok(long.endsWith('…'));
  assert.equal(describeError(new TypeError('two\n\nlines   here')), 'TypeError: two lines here');
});

test('a URL that is not a string is not linkable and does not throw', () => {
  /*
   * `urlScheme` in the protocol package trusts its parameter's type, which is
   * true for the relay and not for the console: these strings come off the
   * event stream. A `page.navigated` with `url: null` reached safeHref and
   * threw out of the Console panel's render.
   */
  for (const bad of [null, undefined, 7, {}, []] as unknown as string[]) {
    assert.doesNotThrow(() => safeHref(bad), String(bad));
    assert.equal(safeHref(bad), undefined, String(bad));
    assert.equal(isLinkableUrl(bad), false, String(bad));
    assert.equal(isScriptUrl(bad), false, String(bad));
  }
  // and a real one is untouched
  assert.equal(safeHref('https://example.test/a.js'), 'https://example.test/a.js');
  assert.equal(isScriptUrl('javascript:alert(1)'), true);
});

/*
 * Four more that only showed up once this branch sat on top of main: its
 * newer code reads fields my base did not have, and the harness reached them.
 */

test('a string value with no v at all does not throw where its length is read', () => {
  // `{ t: 'string' }` with no `v` is what a page sends to reach ObjectTree's
  // long-string handling, which reads `.length` off it.
  const v = { t: 'string' } as unknown as Extract<SerializedValue, { t: 'string' }>;
  assert.doesNotThrow(() => formatValue(v, 'top'));
  assert.doesNotThrow(() => formatValue(v, 'nested'));
});

test('a node preview with no nodeName does not throw', () => {
  for (const nodeName of [null, undefined, 7]) {
    const v = { t: 'node', nodeType: 1, nodeName, preview: '' } as unknown as SerializedValue;
    assert.doesNotThrow(() => formatValue(v, 'nested'), String(nodeName));
  }
});

test('history items are always strings, so React never gets an object child', () => {
  // React error #31 — "objects are not valid as a React child" — took the
  // History panel down when a mark name or an error message was an object.
  const items = buildItems({
    history: [{ type: 'interaction.click', ts: 1, tag: null, text: {}, selector: 7 }],
    console: [{ type: 'error.uncaught', ts: 2, seq: 1, message: { not: 'a string' } }],
    network: [],
    pageTiming: {},
  } as never);
  assert.ok(items.length >= 2);
  for (const i of items) {
    assert.equal(typeof i.label, 'string', JSON.stringify(i));
    assert.equal(typeof i.kind, 'string', JSON.stringify(i));
    assert.equal(typeof i.ts, 'number');
    if (i.detail !== undefined) assert.equal(typeof i.detail, 'string');
  }
});

test('Network Find survives a request whose header map is not an object', () => {
  // `Object.entries(null)` throws, and Find walks both header maps of every
  // entry in the grid.
  const entries = [
    { requestId: 'a', seq: 1, request: { ts: 1, url: 'https://x/a', method: 'GET', kind: 'fetch', headers: null } },
    { requestId: 'b', seq: 2, request: { ts: 2, url: 'https://x/b', method: 'GET', kind: 'fetch', headers: 'nope' }, response: { status: 200, headers: null } },
    { requestId: 'c', seq: 3, request: { ts: 3, url: 'https://x/c', method: 'GET', kind: 'fetch', headers: { 'x-a': 7 } }, response: { status: 200, headers: { 'x-b': null } } },
  ] as never;
  let result: ReturnType<typeof searchEntries> | undefined;
  assert.doesNotThrow(() => {
    result = searchEntries(entries, 'x-', { regex: false, caseSensitive: false }, () => null);
  });
  // the one real header still matches, and every label and snippet is a string
  assert.ok(result);
  assert.ok(result.hits.length >= 1);
  for (const h of result.hits) {
    assert.equal(typeof h.label, 'string');
    assert.equal(typeof h.snippet, 'string');
  }
});

test('a snapshot nested deeper than the stack allows is capped, not fatal', () => {
  /*
   * Both consumers build the tree by recursing, and so does the guard, so a
   * snapshot a couple of thousand deep overflowed the stack — in the transport
   * callback, where no error boundary reaches it, leaving the Elements tree and
   * the mirror dead with nothing on screen to say why. A page builds one with
   * `appendChild` in a loop.
   */
  const deep = (n: number): unknown => {
    let node: unknown = { id: n + 1, t: 'tx', text: 'leaf' };
    for (let i = n; i > 0; i--) node = { id: i, t: 'el', tag: 'div', attrs: {}, children: [node] };
    return node;
  };

  for (const depth of [300, 2_000, 500_000]) {
    let tree: ReturnType<typeof usableSnapshot> = [];
    assert.doesNotThrow(() => {
      tree = usableSnapshot([deep(depth)]);
    }, `guard at depth ${depth}`);
    // the consumers walk the result, so they have to survive it too
    assert.doesNotThrow(() => new DomModel().load(tree as never), `model at depth ${depth}`);

    let node = tree[0];
    let kept = 0;
    while (node && node.t === 'el' && node.children.length) {
      kept++;
      node = node.children[0];
    }
    assert.ok(kept <= 257, `kept ${kept} levels at depth ${depth}`);
    // and the cut says so rather than passing off a shallower page as the page
    assert.equal(node?.t, 'cm');
    assert.match((node as { text: string }).text, /nesting past 256 levels is not shown/);
  }

  // a tree within the cap is untouched, markers and all
  const shallow = usableSnapshot([deep(100)]);
  let node = shallow[0];
  let kept = 0;
  while (node && node.t === 'el' && node.children.length) {
    kept++;
    node = node.children[0];
  }
  assert.equal(kept, 100);
  assert.equal(node?.t, 'tx');
});

test('marker ids cannot collide with the ids the page is using', () => {
  // Real ids come from the page's counter and are addressed by later ops; a
  // marker standing in for one of those would be applied to the wrong node.
  const deep = (n: number): unknown => {
    let node: unknown = { id: n + 1, t: 'tx', text: 'leaf' };
    for (let i = n; i > 0; i--) node = { id: i, t: 'el', tag: 'div', attrs: {}, children: [node] };
    return node;
  };
  const ids: number[] = [];
  const walk = (n: ReturnType<typeof usableNode>): void => {
    if (!n) return;
    ids.push(n.id);
    if (n.t === 'el') for (const c of n.children) walk(c);
  };
  walk(usableSnapshot([deep(600)])[0] ?? null);
  const markers = ids.filter((id) => id <= 0);
  const real = ids.filter((id) => id > 0);
  assert.equal(markers.length, 1);
  assert.equal(new Set(ids).size, ids.length, 'no id appears twice');
  assert.ok(real.every((id) => id > 0));
});

test('a hostile replay segment degrades the player instead of breaking it', async () => {
  /*
   * `ScreenSegment` is assembled by the relay out of a recording the page
   * wrote, and the player does time arithmetic on its `bounds`, `batches` and
   * `pointer`. Nothing was found to fix here — this pins that down, because
   * the module is four hundred lines of clock and every one of its inputs
   * comes from the recording.
   */
  const segments: Array<[string, unknown]> = [
    ['null', null],
    ['bounds null', { bounds: null, batches: [], done: true, changes: 0, from: 0 }],
    ['bounds NaN', { bounds: { start: NaN, end: NaN }, batches: [], done: true, changes: 0, from: 0 }],
    ['bounds reversed', { bounds: { start: 100, end: 1 }, batches: [], done: true, changes: 0, from: 0 }],
    ['bounds not numbers', { bounds: { start: 'a', end: 'b' }, batches: [], done: true, changes: 'x', from: 'y' }],
    ['batches not an array', { bounds: { start: 0, end: 10 }, batches: 'nope', done: true, changes: 0, from: 0 }],
    ['batch fields wrong', { bounds: { start: 0, end: 10 }, batches: [{ ts: 'soon', ops: null }, null], done: true, changes: 0, from: 0 }],
    ['snapshot not an object', { bounds: { start: 0, end: 10 }, snapshot: 'nope', batches: [], done: true, changes: 0, from: 0 }],
    ['snapshot doc null', { bounds: { start: 0, end: 10 }, snapshot: { type: 'screen.snapshot', ts: 0, doc: null }, batches: [], done: true, changes: 0, from: 0 }],
    ['pointer not an array', { bounds: { start: 0, end: 10 }, batches: [], pointer: 'nope', done: true, changes: 0, from: 0 }],
    ['pointer entries wrong', { bounds: { start: 0, end: 10 }, batches: [], pointer: [null, { ts: 'x', x: 'y', y: null }], done: true, changes: 0, from: 0 }],
  ];

  for (const [name, segment] of segments) {
    const replayer = new ScreenReplayer({
      sessionId: 's',
      // the mirror's own guard is what makes a null doc survivable here
      loadSnapshot: (snap) => void usableSnapshot(snap.doc),
      applyOps: (ops) => void usableOps(ops),
      onStatus: () => {},
      fetchSegment: () => Promise.resolve(segment as never),
      frames: { now: () => 0, request: () => 1, cancel: () => {} },
    });
    await assert.doesNotReject(async () => {
      await replayer.rewind();
      await replayer.seek(5);
      replayer.stepForward();
      replayer.stepBack();
      replayer.setSpeed(2);
      replayer.getStatus();
    }, `segment: ${name}`);
  }
});
