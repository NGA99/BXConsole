/**
 * The script that runs the moment the agent lands.
 *
 * It executes attacker-authored code in someone else's browser at install
 * time, so the failures that matter are the ones that cost the run: a script
 * that throws must not stop the agent, and a result that never arrives must
 * not be reported as one. The window it runs in is usually the only chance at
 * that page.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PRE_PAYLOAD_MARK, runPrePayload } from '../src/pre-payload';

/** Collects what the runner marks into History, in place of a transport. */
function recorder() {
  const marks: Array<{ name: string; data: unknown }> = [];
  const transport = {
    send(msg: { type: string; name?: string; data?: unknown }) {
      if (msg.type === 'mark.custom') marks.push({ name: msg.name!, data: msg.data });
    },
  };
  return { transport: transport as never, marks };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

let scratch: Record<string, unknown>;
beforeEach(() => {
  scratch = {};
  (globalThis as Record<string, unknown>).__probe = scratch;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__probe;
});

describe('what it runs', () => {
  test('nothing at all when there is no script', () => {
    const { transport, marks } = recorder();
    for (const source of [undefined, null, '', '   ', '\n\n']) {
      runPrePayload(transport, source);
    }
    assert.deepEqual(marks, []);
  });

  test('a bare expression is marked, which is the common case', () => {
    const { transport, marks } = recorder();
    runPrePayload(transport, '"session=abc123"');
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.name, PRE_PAYLOAD_MARK);
  });

  test('it runs in global scope, so it can reach the page', () => {
    const { transport } = recorder();
    runPrePayload(transport, '__probe.ran = true');
    assert.equal(scratch.ran, true);
  });

  test('a script that returns nothing is run but not reported', () => {
    const { transport, marks } = recorder();
    runPrePayload(transport, '__probe.side = 1; undefined');
    assert.equal(scratch.side, 1, 'it still ran');
    assert.deepEqual(marks, [], 'but there was nothing to say about it');
  });
});

describe('when it goes wrong', () => {
  test('a throwing script costs its own result and nothing else', () => {
    // The agent must survive it: the run this was attached to is usually the
    // only chance at that page.
    const { transport, marks } = recorder();
    assert.doesNotThrow(() => runPrePayload(transport, 'throw new TypeError("no such thing")'));
    assert.equal(marks.length, 1);
    assert.match(JSON.stringify(marks[0]!.data), /TypeError/);
    assert.match(JSON.stringify(marks[0]!.data), /no such thing/);
  });

  test('a syntax error is reported rather than swallowed', () => {
    const { transport, marks } = recorder();
    assert.doesNotThrow(() => runPrePayload(transport, 'function (' ));
    assert.equal(marks.length, 1);
    assert.match(JSON.stringify(marks[0]!.data), /error/i);
  });
});

describe('a script that answers later', () => {
  test('a promise is waited for, not marked as "[object Promise]"', async () => {
    const { transport, marks } = recorder();
    runPrePayload(transport, 'Promise.resolve("token=xyz")');
    assert.deepEqual(marks, [], 'nothing yet');
    await settle();
    assert.equal(marks.length, 1);
    assert.match(JSON.stringify(marks[0]!.data), /token=xyz/);
  });

  test('a rejected promise is reported as an error, once', async () => {
    const { transport, marks } = recorder();
    runPrePayload(transport, 'Promise.reject(new Error("blocked by CORS"))');
    await settle();
    assert.equal(marks.length, 1);
    assert.match(JSON.stringify(marks[0]!.data), /blocked by CORS/);
  });

  test('a promise that never settles never reports, and does not hang the agent', async () => {
    const { transport, marks } = recorder();
    assert.doesNotThrow(() => runPrePayload(transport, 'new Promise(() => {})'));
    await settle();
    assert.deepEqual(marks, []);
  });
});
