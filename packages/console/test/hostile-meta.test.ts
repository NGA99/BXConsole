import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMeta } from '@bxconsole/protocol';
import { normalizeMeta } from '../src/state/sessions';
import { shortSelector } from '../src/panels/history/items';
import { parseStack } from '../src/panels/console/stack';
import { formatValue } from '../src/panels/console/format';
import { applyFormat } from '../src/panels/console/format-spec';
import { typeLabel } from '../src/panels/network/classify';
import { describe as describeTab } from '../src/app/tab-label';

/*
 * The relay writes what the page sends. A `page.navigated` with `url: null`
 * lands in meta.json, and the Sessions list — the console's front page — used
 * to throw while rendering it, blanking the UI for every session until the
 * file was edited by hand. These values are typed, not validated, so the casts
 * below are the point of the test rather than a shortcut.
 */
const hostile = {
  sessionId: 'qa',
  name: 12,
  url: null,
  title: 12,
  userAgent: { not: 'a string' },
  viewport: null,
  startedAt: 'soon',
  lastSeenAt: null,
  connected: 'yes',
  tabs: [{ tabId: 7, url: null, title: undefined, viewport: 'big', startedAt: null, lastSeenAt: 'x', connected: 1 }],
} as unknown as SessionMeta;

test('a session whose strings are not strings still renders as strings', () => {
  const m = normalizeMeta(hostile);
  assert.equal(typeof m.url, 'string');
  assert.equal(m.url, '');
  assert.equal(m.title, '12');
  assert.equal(typeof m.userAgent, 'string');
  // name is nullable by design, so a non-string becomes null, not "12"
  assert.equal(m.name, null);
  assert.equal(typeof m.viewport.width, 'number');
  assert.equal(m.viewport.dpr, 1);
  assert.equal(typeof m.startedAt, 'number');
  assert.equal(m.connected, true);
});

test('the tabs of such a session are normalized too', () => {
  const [tab] = normalizeMeta(hostile).tabs;
  assert.ok(tab);
  assert.equal(tab.tabId, '7');
  assert.equal(tab.url, '');
  assert.equal(tab.title, '');
  assert.equal(typeof tab.viewport.height, 'number');
  assert.equal(tab.connected, true);
});

test('a missing or non-array tabs list does not become one', () => {
  assert.deepEqual(normalizeMeta({ sessionId: 'a' } as unknown as SessionMeta).tabs, []);
  assert.deepEqual(normalizeMeta({ sessionId: 'a', tabs: 'two' } as unknown as SessionMeta).tabs, []);
});

test('what the panels do with those values no longer throws', () => {
  const m = normalizeMeta(hostile);
  // the three display helpers that killed the list, in the form they use
  assert.doesNotThrow(() => new URL(m.url, 'http://x/'));
  assert.doesNotThrow(() => m.url.slice(0, 10));
  assert.doesNotThrow(() => m.title.length);
});

test('a selector that is not a string does not take the History panel down', () => {
  assert.equal(shortSelector(7 as unknown as string), '7');
  assert.equal(shortSelector(null as unknown as string), '');
  assert.equal(shortSelector(undefined as unknown as string), '');
  assert.equal(shortSelector('body > div > #a'), '#a');
});

/*
 * The same problem one layer in: fields the panels read off an event. Each of
 * these threw during render and unmounted the panel, which for the Sessions
 * list meant the whole console.
 */

test('a stack that is not a string yields no frames instead of throwing', () => {
  assert.deepEqual(parseStack(['an', 'array'] as unknown as string), []);
  assert.deepEqual(parseStack({} as unknown as string), []);
  assert.deepEqual(parseStack(7 as unknown as string), []);
  // and a real one still parses
  assert.equal(parseStack('    at f (https://x/a.js:1:2)').length, 1);
});

test('a preview that is not an array formats as empty instead of throwing', () => {
  const bad = [
    { t: 'array', length: 'many', preview: null },
    { t: 'object', className: 'X', preview: 'not-an-array' },
    { t: 'map', size: 2, preview: null },
    { t: 'set', size: 2, preview: undefined },
  ] as unknown as Parameters<typeof formatValue>[0][];
  for (const v of bad) assert.doesNotThrow(() => formatValue(v, 'top'), JSON.stringify(v));
});

test('console args that are not an array produce no segments instead of throwing', () => {
  assert.doesNotThrow(() => applyFormat('not-an-array' as never));
  assert.doesNotThrow(() => applyFormat(null as never));
  assert.deepEqual(applyFormat(null as never), []);
  // a %c whose style argument has no value at all
  assert.doesNotThrow(() => applyFormat([{ t: 'string', v: '%cx' }, { t: 'string' }] as never));
});

test('a response mimeType that is not a string does not take the Network grid down', () => {
  const entry = { requestId: 'r', seq: 1, request: { kind: 'fetch', url: 'https://x/a', method: 'GET' }, response: { mimeType: 5 } };
  assert.doesNotThrow(() => typeLabel(entry as never));
  assert.equal(typeof typeLabel(entry as never), 'string');
});

test('the ingest chokepoint is what keeps the window tabs safe', () => {
  /*
   * `app/tab-label.ts` reads a tab's title, url, timestamps and viewport and
   * is not defensive about any of them — it does not need to be, because every
   * tab it sees came through normalizeMeta. This test is here so that stays
   * true: it is the claim that justifies not guarding that file.
   */
  const meta = normalizeMeta({
    sessionId: 's',
    tabs: [{ tabId: 7, url: null, title: {}, viewport: 'big', startedAt: null, lastSeenAt: 'x', connected: 1 }],
  } as unknown as SessionMeta);
  const tab = meta.tabs[0];
  assert.ok(tab);
  const text = describeTab(tab, 0);
  assert.equal(typeof text, 'string');
  assert.ok(!text.includes('NaN'), text);
  assert.ok(!text.includes('undefined'), text);
  assert.ok(text.includes('Viewport 0×0'));
});
