/**
 * What the recording says about a request body the hook did not read.
 *
 * A body is only taken when it can be had for free; a stream, a Blob or a
 * Request's own body is left alone, because reading it would consume what
 * the page is about to send. But weeks later a POST showing no payload reads
 * as a page that sent none, and that is a different fact. The XHR half of
 * the hook has always named these; the fetch half returned a bare null.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/** The hook's describeRequest, reached through the module's own export list. */
async function load() {
  (globalThis as { window?: unknown }).window = globalThis as unknown as Window;
  return (await import(`../src/hooks/network?${Math.random()}`)) as { describeRequest?: unknown };
}

describe('a body the hook will not read', () => {
  test('a Blob is named with its size, not dropped', async () => {
    const { describeRequest } = (await load()) as {
      describeRequest: (i: unknown, init?: unknown) => { body: string | null };
    };
    const out = describeRequest('/x', { method: 'POST', body: new Blob(['0123456789']) });
    assert.equal(out.body, '[Blob 10 bytes]');
  });

  test('a buffer is named with its length', async () => {
    const { describeRequest } = (await load()) as {
      describeRequest: (i: unknown, init?: unknown) => { body: string | null };
    };
    assert.equal(describeRequest('/x', { method: 'POST', body: new Uint8Array(4) }).body, '[Binary 4 bytes]');
    assert.equal(describeRequest('/x', { method: 'POST', body: new ArrayBuffer(7) }).body, '[Binary 7 bytes]');
  });

  test('a stream is named without being touched', async () => {
    const { describeRequest } = (await load()) as {
      describeRequest: (i: unknown, init?: unknown) => { body: string | null };
    };
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('secret'));
        c.close();
      },
    });
    assert.equal(describeRequest('/x', { method: 'POST', body: stream }).body, '[stream]');
    assert.equal(stream.locked, false, 'reading it would take it from the page');
  });

  test('no body at all is still no body', async () => {
    const { describeRequest } = (await load()) as {
      describeRequest: (i: unknown, init?: unknown) => { body: string | null };
    };
    assert.equal(describeRequest('/x').body, null);
    assert.equal(describeRequest('/x', { method: 'GET' }).body, null);
  });

  test('what can be read for free still is', async () => {
    const { describeRequest } = (await load()) as {
      describeRequest: (i: unknown, init?: unknown) => { body: string | null };
    };
    assert.equal(describeRequest('/x', { method: 'POST', body: 'plain' }).body, 'plain');
    assert.equal(describeRequest('/x', { method: 'POST', body: new URLSearchParams({ a: '1' }) }).body, 'a=1');
  });
});
