/**
 * HAR sizes are byte counts. A JavaScript string's length is UTF-16 code
 * units, which is the same number only for ASCII — so the bug this pins was
 * invisible in English and understated every non-ASCII payload.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { toHar } from '../src/panels/network/har';
import type { NetworkEntry } from '../src/state/session-data';

interface HarShape {
  log: {
    entries: Array<{
      request: { bodySize: number; postData?: { text: string } };
      response: { content: { size: number } };
    }>;
  };
}

const har = async (entries: NetworkEntry[]) => (await toHar(entries, { title: 't', url: 'http://x/', sessionId: 's1' })) as HarShape;

describe('HAR export sizes', () => {
  test('a non-ASCII body is counted in bytes, not characters', async () => {
    const body = JSON.stringify({ msg: 'çafé — naïve ☕' });
    const e = {
      request: { url: 'http://x/a', method: 'POST', headers: { 'content-type': 'application/json' }, ts: 1000, kind: 'fetch', body },
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json', ts: 1050, body: '{"ok":"çafé"}' },
    } as unknown as NetworkEntry;
    const out = (await har([e])).log.entries[0]!;
    assert.equal(body.length, 24, 'the string is 24 UTF-16 units');
    assert.equal(out.request.bodySize, 31, 'but 31 bytes');
    assert.equal(out.response.content.size, 15);
  });

  test('a base64 body reports the decoded size', async () => {
    const e = {
      request: { url: 'http://x/i.png', method: 'GET', headers: {}, ts: 1, kind: 'fetch' },
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'image/png', ts: 2, body: 'AAAA', bodyEncoding: 'base64' },
    } as unknown as NetworkEntry;
    assert.equal((await har([e])).log.entries[0]!.response.content.size, 3);
    const padded = { ...e, response: { ...(e as never as { response: object }).response, body: 'AAA=' } } as unknown as NetworkEntry;
    assert.equal((await har([padded])).log.entries[0]!.response.content.size, 2);
  });

  test('no body is zero, not NaN', async () => {
    const e = {
      request: { url: 'http://x/a', method: 'GET', headers: {}, ts: 1, kind: 'fetch' },
    } as unknown as NetworkEntry;
    const out = (await har([e])).log.entries[0]!;
    assert.equal(out.request.bodySize, 0);
    assert.equal(out.response.content.size, 0);
  });
});
