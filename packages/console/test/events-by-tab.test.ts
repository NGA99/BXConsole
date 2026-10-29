/**
 * How many events each window of a run has produced.
 *
 * Counted as they arrive rather than measured off the arrays the panels read,
 * because those are trimmed: a long run keeps its last 5,000 console rows and
 * 2,000 requests, so their lengths stop being the answer well before a busy
 * window does. The number exists to tell one window of a run from another —
 * a real session here had one window on 1,902 events and another on 126, and
 * the strip showed them identically.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@bxconsole/protocol';
import { sessionData, dropSessionData } from '../src/state/session-data';

const SID = 'counts01';
const store = () => sessionData(SID).getState();

const request = (i: number): AgentEvent => ({
  type: 'network.request',
  ts: 1000 + i,
  requestId: `r${i}`,
  kind: 'fetch',
  method: 'GET',
  url: `http://app.test/${i}`,
  headers: {},
  body: null,
});
const message = (i: number): AgentEvent => ({
  type: 'console.message',
  ts: 1000 + i,
  level: 'log',
  args: [{ t: 'string', v: `line ${i}` }],
  // Not inside a `console.group`. These are counted, not grouped, so the
  // depth is only here because the agent always reports one.
  groupDepth: 0,
});

beforeEach(() => {
  dropSessionData(SID);
  store().reset();
});

describe('counting what each window did', () => {
  test('every event counts towards the window that produced it', () => {
    store().push(1, request(1), 'win-a');
    store().push(2, request(2), 'win-a');
    store().push(3, message(3), 'win-b');
    assert.deepEqual(store().eventsByTab, { 'win-a': 2, 'win-b': 1 });
  });

  test('a replayed recording counts the same as a live run', () => {
    store().pushMany(
      [
        { seq: 1, event: request(1), tabId: 'win-a' },
        { seq: 2, event: request(2), tabId: 'win-a' },
        { seq: 3, event: message(3), tabId: 'win-b' },
      ],
      true,
    );
    assert.deepEqual(store().eventsByTab, { 'win-a': 2, 'win-b': 1 });
  });

  test('live events add to what a replay already counted', () => {
    store().pushMany([{ seq: 1, event: request(1), tabId: 'win-a' }], true);
    store().push(2, request(2), 'win-a');
    assert.equal(store().eventsByTab['win-a'], 2);
  });

  test('the count outlives the buffers it cannot be measured from', () => {
    /*
     * This is the whole reason it is a counter. The console keeps its last
     * 5,000 rows; push more than that and the array stops growing while the
     * window plainly kept going.
     */
    for (let i = 0; i < 5200; i++) store().push(i + 1, message(i), 'win-a');
    assert.equal(store().console.length, 5000, 'the buffer is meant to be capped');
    assert.equal(store().eventsByTab['win-a'], 5200, 'the count was taken from the capped buffer');
  });

  test('an event from before windows were recorded belongs to no window', () => {
    // Older recordings carry no tabId; counting them under a made-up key
    // would put a tab in the strip that never existed.
    store().push(1, request(1), undefined);
    store().push(2, request(2), 'win-a');
    assert.deepEqual(store().eventsByTab, { 'win-a': 1 });
  });

  test('reset clears the counts with everything else', () => {
    store().push(1, request(1), 'win-a');
    store().reset();
    assert.deepEqual(store().eventsByTab, {});
  });
});
