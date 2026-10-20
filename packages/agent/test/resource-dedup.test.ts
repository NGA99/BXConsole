/**
 * One request, one row.
 *
 * Resource Timing reports everything the page loaded, including the calls the
 * fetch, XHR, beacon and EventSource hooks already described in full. Letting
 * both through puts two rows in the Network panel for one call — one with the
 * body, the stack and the real status, one with none of them — and nothing
 * says they are the same request. The hooks that arrived later, beacon and
 * EventSource, did exactly that until this.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { alreadyReported } from '../src/hooks/resources';
import { hookedOtherUrls } from '../src/hooks/reported';

const SSE = 'http://app.test/stream';

beforeEach(() => hookedOtherUrls.clear());

describe('entries a request hook already covered', () => {
  test('the three the initiator type settles', () => {
    for (const type of ['fetch', 'xmlhttprequest', 'beacon']) {
      assert.equal(alreadyReported(type, 'http://app.test/x'), true, type);
    }
  });

  test('everything the resource hook is the only reporter of stays', () => {
    for (const type of ['link', 'script', 'img', 'css', 'font', 'iframe', 'navigation', '']) {
      assert.equal(alreadyReported(type, 'http://app.test/x'), false, type);
    }
  });

  test('an EventSource is matched by URL, since the browser files it under "other"', () => {
    assert.equal(alreadyReported('other', SSE), false, 'nothing opened it yet');
    hookedOtherUrls.add(SSE);
    assert.equal(alreadyReported('other', SSE), true);
  });

  test('another "other" request is not swept up with it', () => {
    hookedOtherUrls.add(SSE);
    assert.equal(alreadyReported('other', 'http://app.test/something-else'), false);
  });

  test('a URL opened as a stream is still reported when something else loads it', () => {
    // Only `other` is matched by URL: an <img> pointed at the same address is
    // a different request and the resource hook is its only reporter.
    hookedOtherUrls.add(SSE);
    assert.equal(alreadyReported('img', SSE), false);
    assert.equal(alreadyReported('script', SSE), false);
  });
});
