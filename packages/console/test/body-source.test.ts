/**
 * Which copy of a response body the drawer shows.
 *
 * Three bugs lived here, all about the source rather than the rendering.
 * Selecting a second JS file while the Response tab was open showed the
 * first file's body, because the decision had been copied into component
 * state and the state did not reset with the selection. A run that had ended
 * still asked the page for a body it had never captured — fifteen seconds of
 * nothing, then "no reply from the page". And the fix for that went too far:
 * gating on the connection hid the bodies the relay had kept, so a file the
 * Sources tab opened happily read as "not captured" in Network.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkEntry } from '../src/state/session-data';
import { bodySource } from '../src/panels/network/body-source';

const SHA = 'a'.repeat(64);

const entry = (over: { request?: Record<string, unknown>; response?: Record<string, unknown> | null; resource?: unknown } = {}): NetworkEntry =>
  ({
    requestId: 'r1',
    request: { url: 'http://app.test/main.js', method: 'GET', headers: {}, ts: 1, kind: 'fetch', ...over.request },
    ...('resource' in over ? { resource: over.resource } : {}),
    ...(over.response === null
      ? {}
      : { response: { status: 200, statusText: 'OK', headers: {}, ts: 2, mimeType: 'text/javascript', ...over.response } }),
  }) as unknown as NetworkEntry;

describe('the bytes we already have', () => {
  test('a body in the event is used as it is', () => {
    assert.deepEqual(bodySource(entry({ response: { body: 'console.log(1)' } })), { from: 'event' });
  });

  test('a body in the event needs nothing fetched, whatever the run is doing', () => {
    assert.deepEqual(bodySource(entry({ response: { body: 'console.log(1)' } })), { from: 'event' });
  });

  test('a truncated body is not the body, so a fresh read is better', () => {
    assert.deepEqual(bodySource(entry({ response: { body: 'cut…', bodyTruncated: true } })), { from: 'ask' });
  });

  test('a body held by the relay comes before any re-read', () => {
    assert.deepEqual(bodySource(entry({ response: { bodyRef: SHA } })), { from: 'store', sha: SHA });
  });

  test('a stored body is read straight from its hash, no asking needed', () => {
    assert.deepEqual(bodySource(entry({ response: { bodyRef: SHA } })), { from: 'store', sha: SHA });
  });

  test('a body in the event beats one in the store', () => {
    assert.deepEqual(bodySource(entry({ response: { body: 'inline', bodyRef: SHA } })), { from: 'event' });
  });
});

describe('asking the relay', () => {
  test('a GET whose body the event does not carry is asked for', () => {
    assert.deepEqual(bodySource(entry()), { from: 'ask' });
  });

  test('an ended run is still asked: the relay may have kept the file', () => {
    // Which is most of why files are collected at all. Refusing to ask here
    // made every collected file unreadable the moment the page closed.
    assert.deepEqual(bodySource(entry()), { from: 'ask' });
  });

  test('a resource row qualifies: the browser loaded it with a GET', () => {
    assert.deepEqual(bodySource(entry({ resource: { name: 'http://app.test/a.js' } })), { from: 'ask' });
  });

  test('a POST is not replayed as a GET', () => {
    // It would show the order list as if it were the POST's response, and hit
    // an endpoint nobody asked for.
    assert.deepEqual(bodySource(entry({ request: { method: 'POST' } })), { from: 'nowhere', why: 'not-re-readable' });
    for (const m of ['PUT', 'DELETE', 'PATCH', 'post']) {
      assert.equal(bodySource(entry({ request: { method: m } })).from, 'nowhere', m);
    }
  });

  test('a lowercase get is still a get', () => {
    assert.deepEqual(bodySource(entry({ request: { method: 'get' } })), { from: 'ask' });
  });
});

describe('when nobody can be asked', () => {
  test('an opaque response was unreadable to the page itself', () => {
    assert.deepEqual(bodySource(entry({ response: { responseType: 'opaque' } })), { from: 'nowhere', why: 'no-response' });
  });

  test('a WebSocket has frames, not a body', () => {
    assert.deepEqual(bodySource(entry({ request: { kind: 'websocket' } })), { from: 'nowhere', why: 'no-response' });
  });

  test('a request still in flight is asked for like any other GET', () => {
    assert.deepEqual(bodySource(entry({ response: null })), { from: 'ask' });
  });
});

describe('moving between rows', () => {
  test('each row answers for itself, with no memory of the last one', () => {
    // The drawer is one component reused as the selection moves. When the
    // answer was kept in state, the second row showed the first row's body.
    const rows = [
      entry({ response: { body: 'first' } }),
      entry({ response: { bodyRef: SHA } }),
      entry({ request: { method: 'POST' } }),
      entry(),
    ];
    assert.deepEqual(
      rows.map((r) => bodySource(r).from),
      ['event', 'store', 'nowhere', 'ask'],
    );
    // And again in reverse: the function has no state to carry either way.
    assert.deepEqual(
      [...rows].reverse().map((r) => bodySource(r).from),
      ['ask', 'nowhere', 'store', 'event'],
    );
  });

  test('two rows on one url with different bodies do not share an answer', () => {
    const a = entry({ response: { bodyRef: 'a'.repeat(64) } });
    const b = entry({ response: { bodyRef: 'b'.repeat(64) } });
    assert.notDeepEqual(bodySource(a), bodySource(b));
  });
});
