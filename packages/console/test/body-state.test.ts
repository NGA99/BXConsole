/**
 * Whether a row's body can still be read, and from where.
 *
 * This is the column a reader scans to decide what is worth opening, so a
 * wrong answer here is worse than no column: it says a body is lost when it
 * is on disk, or promises one that is gone. The hard part is that most rows
 * cannot be judged from the event alone — the relay has to say what it kept.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkEntry } from '../src/state/session-data';
import { BAND, LABEL, bodyState, bodyTitle, type BodyState } from '../src/panels/network/body-state';

const URL_JS = 'http://app.test/main.js';
const SHA = 'a'.repeat(64);
const NOTHING_KEPT: ReadonlySet<string> = new Set();
const KEPT: ReadonlySet<string> = new Set([URL_JS]);
const LIVE = true;
const ENDED = false;

const entry = (over: { request?: Record<string, unknown>; response?: Record<string, unknown> | null; resource?: unknown } = {}): NetworkEntry =>
  ({
    requestId: 'r1',
    request: { url: URL_JS, method: 'GET', headers: {}, ts: 1, kind: 'fetch', ...over.request },
    ...('resource' in over ? { resource: over.resource } : {}),
    ...(over.response === null
      ? {}
      : { response: { status: 200, statusText: 'OK', headers: {}, ts: 2, mimeType: 'text/javascript', ...over.response } }),
  }) as unknown as NetworkEntry;

describe('bodies the recording already holds', () => {
  test('a captured body is captured whether or not the run is live', () => {
    const e = entry({ response: { body: 'console.log(1)' } });
    assert.equal(bodyState(e, NOTHING_KEPT, LIVE), 'captured');
    assert.equal(bodyState(e, NOTHING_KEPT, ENDED), 'captured');
  });

  test('a body moved into the store by its hash is still the run’s own', () => {
    // bodyRef means the relay took it out of the line to keep the file small.
    // It is the same bytes, so it reads as captured rather than as a copy.
    const e = entry({ response: { bodyRef: SHA } });
    assert.equal(bodyState(e, NOTHING_KEPT, ENDED), 'captured');
  });

  test('a truncated body is not the body', () => {
    const e = entry({ response: { body: 'cut…', bodyTruncated: true } });
    assert.equal(bodyState(e, NOTHING_KEPT, ENDED), 'lost');
    assert.equal(bodyState(e, KEPT, ENDED), 'stored');
  });
});

describe('what the relay kept', () => {
  test('a file in the manifest reads back after the run has ended', () => {
    assert.equal(bodyState(entry(), KEPT, ENDED), 'stored');
  });

  test('and it is preferred over asking the page, even while live', () => {
    assert.equal(bodyState(entry(), KEPT, LIVE), 'stored');
  });

  test('a file not in the manifest depends on the run still being up', () => {
    assert.equal(bodyState(entry(), NOTHING_KEPT, LIVE), 'live-only');
    assert.equal(bodyState(entry(), NOTHING_KEPT, ENDED), 'lost');
  });

  test('the manifest is matched by exact url, not by name', () => {
    const other = entry({ request: { url: 'http://app.test/other.js' } });
    assert.equal(bodyState(other, KEPT, ENDED), 'lost');
  });

  test('an empty manifest reads as nothing kept, which is the honest default', () => {
    // It is empty before the relay has answered, and saying "lost" early is
    // better than promising a body that turns out not to be there.
    assert.equal(bodyState(entry(), new Set(), ENDED), 'lost');
  });
});

describe('rows that never have a body', () => {
  test('a resource row still qualifies: the browser loaded it with a GET', () => {
    const img = entry({ resource: { name: URL_JS } });
    assert.equal(bodyState(img, KEPT, ENDED), 'stored');
    assert.equal(bodyState(img, NOTHING_KEPT, LIVE), 'live-only');
  });

  test('a picture is not a special case: kept means previewable', () => {
    // The relay keeps images for the Screen mirror, so an image it holds can
    // be drawn in Preview. Calling every image "no body" would hide the ones
    // that are right there.
    const img = entry({ resource: { name: URL_JS }, response: { mimeType: 'image/png' } });
    assert.equal(bodyState(img, KEPT, ENDED), 'stored');
    assert.equal(bodyState(img, NOTHING_KEPT, ENDED), 'lost');
  });

  test('an opaque response was unreadable to the page itself', () => {
    assert.equal(bodyState(entry({ response: { responseType: 'opaque' } }), KEPT, LIVE), 'none');
  });

  test('a WebSocket carries frames, not a body', () => {
    assert.equal(bodyState(entry({ request: { kind: 'websocket' } }), KEPT, LIVE), 'none');
  });

  test('a non-GET that was not captured cannot be safely repeated', () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal(bodyState(entry({ request: { method: m } }), KEPT, LIVE), 'none', m);
    }
  });

  test('but a non-GET whose body was captured shows it', () => {
    const e = entry({ request: { method: 'POST' }, response: { body: '{"ok":1}' } });
    assert.equal(bodyState(e, NOTHING_KEPT, ENDED), 'captured');
  });

  test('a lowercase get is a get', () => {
    assert.equal(bodyState(entry({ request: { method: 'get' } }), KEPT, ENDED), 'stored');
  });
});

describe('the three bands a reader scans', () => {
  test('every state belongs to exactly one band, and each band is used', () => {
    const states: BodyState[] = ['captured', 'stored', 'live-only', 'lost', 'none'];
    assert.deepEqual(
      states.map((s) => BAND[s]),
      ['local', 'local', 'live', 'never', 'never'],
    );
  });

  test('every state has a label, and no two share one', () => {
    const labels = Object.values(LABEL);
    assert.equal(labels.length, new Set(labels).size);
    for (const l of labels) assert.match(l, /^[A-Z]/, `"${l}" should read as a label`);
  });

  test('a row in the local band is readable with the run gone', () => {
    const readable = (e: NetworkEntry, kept: ReadonlySet<string>) => BAND[bodyState(e, kept, ENDED)] === 'local';
    assert.ok(readable(entry({ response: { body: 'x' } }), NOTHING_KEPT));
    assert.ok(readable(entry(), KEPT));
    assert.ok(!readable(entry(), NOTHING_KEPT));
  });
});

describe('a truncated body that went to the store', () => {
  /** The case the rule above had never been applied to. */
  const cutAndStored = (over: Record<string, unknown> = {}): NetworkEntry =>
    ({
      requestId: 'rT',
      request: { url: URL_JS, method: 'GET', headers: {}, ts: 0 },
      response: { status: 200, headers: {}, bodyRef: 'a'.repeat(64), bodyBytes: 49152, bodyTruncated: true, ...over },
    }) as unknown as NetworkEntry;

  test('is not called captured — the same rule the inline branch states', () => {
    // A five-megabyte response of which forty-eight kilobytes survived read
    // as "Captured. It is part of the recording."
    assert.notEqual(bodyState(cutAndStored(), NOTHING_KEPT, ENDED), 'captured');
  });

  test('falls through to the answers a cut inline body already got', () => {
    assert.equal(bodyState(cutAndStored(), NOTHING_KEPT, ENDED), 'lost');
    assert.equal(bodyState(cutAndStored(), KEPT, ENDED), 'stored');
  });

  test('a whole body in the store is still captured', () => {
    assert.equal(bodyState(cutAndStored({ bodyTruncated: undefined }), NOTHING_KEPT, ENDED), 'captured');
  });
});

describe('what the dropped-body note claims', () => {
  test('it no longer quotes a run budget this console was never told', () => {
    const dropped = {
      requestId: 'rD',
      request: { url: 'https://site.example/x', method: 'GET', headers: {}, ts: 0 },
      response: { status: 200, headers: {}, bodyDropped: true, bodyBytes: 49152 },
    } as unknown as NetworkEntry;
    const title = bodyTitle(dropped, bodyState(dropped, NOTHING_KEPT, ENDED));
    assert.ok(!/50 MB/.test(title), `still quoting a figure it cannot know: ${title}`);
    assert.match(title, /4 MB each/);
    assert.match(title, /49,152 bytes/);
  });
});
