/**
 * The two kinds of request that stay open, and the one that never answers.
 *
 * WebSockets and EventSource both hold a connection and deliver frames rather
 * than a body, and every place the panel treated the first specially meant
 * that rather than "is a websocket" — the pending-row clock, the Frames tab,
 * both body readers. Server-sent events arrived later and inherited none of
 * it: an EventSource row offered a response body to fetch, hid its frames,
 * and kept the whole grid re-rendering once a second for as long as it was
 * open. `streamsFrames` is the name those places now share.
 *
 * A beacon is the opposite shape: it goes out and there is never a response,
 * because the browser only tells the page whether it took the payload. Its
 * row said "(pending)" forever.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkEntry } from '../src/state/session-data';
import { classify, statusLabel, statusTitle, streamsFrames, TYPE_CHIPS } from '../src/panels/network/classify';
import { bodyState } from '../src/panels/network/body-state';
import { bodySource } from '../src/panels/network/body-source';

const NOTHING_KEPT: ReadonlySet<string> = new Set();

const entry = (kind: string, over: Record<string, unknown> = {}): NetworkEntry =>
  ({
    requestId: 'r1',
    request: { url: 'http://app.test/stream', method: 'GET', headers: {}, ts: 1, kind },
    ...over,
  }) as unknown as NetworkEntry;

describe('requests that stay open', () => {
  test('both long-lived kinds are recognised, and nothing else is', () => {
    assert.equal(streamsFrames(entry('websocket')), true);
    assert.equal(streamsFrames(entry('eventsource')), true);
    for (const kind of ['fetch', 'xhr', 'beacon', 'resource']) {
      assert.equal(streamsFrames(entry(kind)), false, kind);
    }
  });

  test('an EventSource has its own type and filter, rather than reading as a socket', () => {
    assert.equal(classify(entry('eventsource')), 'eventsource');
    assert.equal(classify(entry('websocket')), 'ws');
    const chip = TYPE_CHIPS.find((c) => c.id === 'eventsource');
    assert.ok(chip, 'no EventSource filter chip');
    assert.equal(chip!.matches('eventsource'), true);
    assert.equal(chip!.matches('ws'), false, 'the EventSource chip also catches sockets');
    assert.equal(TYPE_CHIPS.find((c) => c.id === 'ws')!.matches('eventsource'), false, 'the Socket chip also catches EventSource');
  });

  test('neither offers a response body to go and read', () => {
    for (const kind of ['websocket', 'eventsource']) {
      assert.equal(bodyState(entry(kind), NOTHING_KEPT, false), 'none', kind);
      assert.equal(bodySource(entry(kind)).from, 'nowhere', kind);
    }
  });
});

describe('a beacon, which never gets a response', () => {
  test('a beacon the browser took is queued, not pending', () => {
    const queued = entry('beacon', { finished: { ts: 2, durationMs: 0 } });
    assert.equal(statusLabel(queued), '(queued)');
    assert.ok(statusTitle(queued)?.includes('no response'), 'nothing explains the status');
  });

  test('before the browser answers it is still pending', () => {
    assert.equal(statusLabel(entry('beacon')), '(pending)');
  });

  test('a refused beacon reads as failed, like any other failure', () => {
    assert.equal(statusLabel(entry('beacon', { failed: { ts: 2, error: 'sendBeacon refused the payload' } })), '(failed)');
  });

  test('an ordinary request with no response is unchanged', () => {
    assert.equal(statusLabel(entry('fetch')), '(pending)');
    assert.equal(statusTitle(entry('fetch', { finished: { ts: 2, durationMs: 1 } })), undefined);
  });
});
