/**
 * Network search over a recording.
 *
 * A recorded run keeps its larger bodies in the relay's store, so some of
 * what a search is asked to look through is not in memory. The failure this
 * pins is not a crash: it is "No matches" returned confidently, having
 * silently skipped the one place the answer was.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkEntry } from '../src/state/session-data';
import { searchEntries } from '../src/panels/network/search';

const OPTS = { regex: false, caseSensitive: false };
const SHA = 'a'.repeat(64);

/** Stands in for the panel's cache of bodies fetched from the relay. */
let cache: Map<string, string | null>;
const loaded = (sha: string) => cache.get(sha) ?? null;
const search = (entries: NetworkEntry[], query: string, opts = OPTS) => searchEntries(entries, query, opts, loaded);

const entry = (over: Record<string, unknown> = {}): NetworkEntry =>
  ({
    requestId: 'r1',
    request: { url: 'http://app.test/api/orders', method: 'GET', headers: {}, ts: 1, kind: 'fetch' },
    response: { status: 200, statusText: 'OK', headers: {}, ts: 2, mimeType: 'application/json' },
    ...over,
  }) as unknown as NetworkEntry;

const withStoredBody = (sha = SHA, mime = 'application/json') =>
  entry({ response: { status: 200, statusText: 'OK', headers: {}, ts: 2, mimeType: mime, bodyRef: sha, bodyBytes: 9000 } });

beforeEach(() => {
  cache = new Map();
});

describe('what is in memory', () => {
  test('an inline body is searched as it always was', () => {
    const e = entry({ response: { status: 200, statusText: 'OK', headers: {}, ts: 2, body: '{"secret":"findme"}' } });
    const { hits, unloaded } = search([e], 'findme', OPTS);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.where, 'response body');
    assert.deepEqual(unloaded, [], 'nothing was left unsearched');
  });

  test('urls and headers are searched without touching the store', () => {
    const e = entry({ request: { url: 'http://app.test/api/orders', method: 'GET', headers: { 'x-trace': 'abc123' }, ts: 1, kind: 'fetch' } });
    assert.equal(search([e], 'orders', OPTS).hits[0]?.where, 'url');
    assert.equal(search([e], 'abc123', OPTS).hits[0]?.where, 'request header');
  });

  test('a base64 body is not searched: its encoding matches nothing anyone meant', () => {
    const e = entry({ response: { status: 200, statusText: 'OK', headers: {}, ts: 2, body: btoa('findme'), bodyEncoding: 'base64' } });
    assert.equal(search([e], 'findme', OPTS).hits.length, 0);
  });
});

describe('a body held by the relay', () => {
  test('it is reported as unsearched rather than passed over in silence', () => {
    const { hits, unloaded } = search([withStoredBody()], 'findme', OPTS);
    assert.equal(hits.length, 0);
    assert.deepEqual(unloaded, [{ sha: SHA, mime: 'application/json' }]);
  });

  test('once loaded it is searched, and reported as unsearched no longer', () => {
    cache.set(SHA, '{"order":{"note":"findme"}}');
    const { hits, unloaded } = search([withStoredBody()], 'findme', OPTS);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.where, 'response body');
    assert.deepEqual(unloaded, []);
  });

  test('loaded and genuinely absent are different answers', () => {
    cache.set(SHA, '{"order":1}');
    const { hits, unloaded } = search([withStoredBody()], 'nothinglikethis', OPTS);
    assert.equal(hits.length, 0);
    assert.deepEqual(unloaded, [], 'it was searched; there is simply no match');
  });

  test('a body that failed to load is not reported as searched', () => {
    cache.set(SHA, null); // a failed fetch reads the same as an absent one
    assert.deepEqual(search([withStoredBody()], 'findme', OPTS).unloaded, [{ sha: SHA, mime: 'application/json' }]);
  });

  test('a binary body is skipped outright, not queued for a fetch nobody wants', () => {
    const png = withStoredBody(SHA, 'image/png');
    const { hits, unloaded } = search([png], 'findme', OPTS);
    assert.equal(hits.length, 0);
    assert.deepEqual(unloaded, [], 'fetching a PNG to grep it would be pure waste');
  });

  test('one body shared by many requests is reported once, so it is fetched once', () => {
    // Content addressing means a polled endpoint's identical responses are
    // one blob; asking for it per row would undo the whole point.
    const rows = [1, 2, 3, 4, 5].map((n) => ({ ...withStoredBody(), requestId: `r${n}` }) as NetworkEntry);
    assert.deepEqual(search(rows, 'findme', OPTS).unloaded, [{ sha: SHA, mime: 'application/json' }]);
  });

  test('a stored request payload is searched too, typed from its headers', () => {
    const e = entry({
      request: { url: 'http://app.test/api/orders', method: 'POST', headers: { 'content-type': 'application/json' }, ts: 1, kind: 'fetch', bodyRef: SHA },
    });
    assert.deepEqual(search([e], 'findme', OPTS).unloaded, [{ sha: SHA, mime: 'application/json' }]);
    cache.set(SHA, '{"note":"findme"}');
    assert.equal(search([e], 'findme', OPTS).hits[0]?.where, 'request body');
  });
});

describe('the query itself', () => {
  test('an empty query searches nothing and asks for nothing', () => {
    assert.deepEqual(search([withStoredBody()], '', OPTS), { hits: [], unloaded: [] });
  });

  test('a broken regex gives up quietly rather than throwing mid-keystroke', () => {
    assert.deepEqual(search([withStoredBody()], '([', { regex: true, caseSensitive: false }), { hits: [], unloaded: [] });
  });

  test('plain text is matched literally, so a dot is a dot', () => {
    const e = entry({ response: { status: 200, statusText: 'OK', headers: {}, ts: 2, body: 'a.b and axb' } });
    assert.equal(search([e], 'a.b', OPTS).hits.length, 1);
    assert.equal(search([e], 'a.b', OPTS).hits[0]!.snippet.includes('a.b'), true);
  });

  test('case folding is off when asked for', () => {
    const e = entry({ response: { status: 200, statusText: 'OK', headers: {}, ts: 2, body: 'FindMe' } });
    assert.equal(search([e], 'findme', OPTS).hits.length, 1);
    assert.equal(search([e], 'findme', { regex: false, caseSensitive: true }).hits.length, 0);
  });
});
