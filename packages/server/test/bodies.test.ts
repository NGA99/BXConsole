/**
 * Response bodies moved out of network.ndjson and into the blob store.
 *
 * The one rule that matters: a recording must never come out with less in it
 * than it went in. The store is allowed to refuse — it is not allowed to make
 * a body disappear, and the sweep is not allowed to collect one a recording
 * still points at.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SESSION_BODIES_INDEX, SESSION_FILES_INDEX, sessionDirName } from '@bxconsole/protocol';
import { BlobStore } from '../src/blobs';
import { bodyOf, carriesBody, withBodyRef } from '../src/net-bodies';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-bodies-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const body = (s: string) => Buffer.from(s, 'utf8');

describe('keeping a body', () => {
  test('a body round-trips through its hash', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('s1', body('{"order":1}'), 'application/json');
    assert.ok(sha, 'nothing was stored');
    assert.equal(String(await blobs.read(sha)), '{"order":1}');
    const record = await blobs.hasBody('s1', sha);
    assert.equal(record?.mime, 'application/json');
    assert.equal(record?.bytes, 11);
  });

  test('the same bytes twice are one copy and one line', async () => {
    const blobs = new BlobStore(dir);
    const a = await blobs.putBody('s1', body('poll: nothing new'), 'application/json');
    const b = await blobs.putBody('s1', body('poll: nothing new'), 'application/json');
    assert.equal(a, b);
    const lines = (await fs.readFile(path.join(dir, sessionDirName('s1'), SESSION_BODIES_INDEX), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, 'a repeated poll should not grow the index');
  });

  test('one session cannot read another’s body by guessing its hash', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('s1', body('private to s1'), 'text/plain');
    assert.ok(await blobs.hasBody('s1', sha!));
    assert.equal(await blobs.hasBody('s2', sha!), null);
  });

  test('a body larger than the store takes is refused, not truncated', async () => {
    const blobs = new BlobStore(dir);
    const huge = Buffer.alloc(5 * 1024 * 1024, 'x');
    assert.equal(await blobs.putBody('s1', huge, 'text/plain'), null);
  });

  test('a body past the session budget is refused, so the caller keeps it inline', async () => {
    const blobs = new BlobStore(dir, 20);
    assert.ok(await blobs.putBody('s1', body('0123456789'), 'text/plain'));
    assert.ok(await blobs.putBody('s1', body('abcdefghij'), 'text/plain'));
    assert.equal(await blobs.putBody('s1', body('this one does not fit'), 'text/plain'), null);
  });

  test('bodies and files share one budget: they are the same disk', async () => {
    const blobs = new BlobStore(dir, 30);
    await blobs.put('s1', 'https://app.test/a.js', Buffer.alloc(25, 'a'), 'text/javascript');
    assert.equal(await blobs.putBody('s1', Buffer.alloc(10, 'b'), 'text/plain'), null, 'the file already spent most of it');
  });
});

describe('the sweep', () => {
  test('a body a recording still points at survives', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('s1', body('still referenced'), 'text/plain');
    const { removed } = await blobs.sweep(0);
    assert.equal(removed, 0, 'the sweep deleted a live body');
    assert.equal(String(await blobs.read(sha!)), 'still referenced');
  });

  test('a body goes once its session’s directory does', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('s1', body('about to be forgotten'), 'text/plain');
    await fs.rm(path.join(dir, sessionDirName('s1')), { recursive: true });
    blobs.forget('s1');
    const { removed } = await blobs.sweep(0);
    assert.equal(removed, 1);
    assert.equal(await blobs.read(sha!), null);
  });

  test('a body shared with a session that remains is kept', async () => {
    const blobs = new BlobStore(dir);
    const shared = body('both runs saw this');
    const sha = await blobs.putBody('s1', shared, 'text/plain');
    await blobs.putBody('s2', shared, 'text/plain');
    await fs.rm(path.join(dir, sessionDirName('s1')), { recursive: true });
    blobs.forget('s1');
    await blobs.sweep(0);
    assert.equal(String(await blobs.read(sha!)), 'both runs saw this');
  });

  test('a file and a body of the same bytes are one blob, kept while either points at it', async () => {
    const blobs = new BlobStore(dir);
    const same = body('identical content');
    const sha = await blobs.put('s1', 'https://app.test/x.js', same, 'text/javascript');
    const bodySha = await blobs.putBody('s2', same, 'text/javascript');
    assert.equal(sha?.sha, bodySha, 'content addressing should make these one file');
    await fs.rm(path.join(dir, sessionDirName('s1')), { recursive: true });
    blobs.forget('s1');
    await blobs.sweep(0);
    assert.equal(String(await blobs.read(bodySha!)), 'identical content');
  });

  test('a half-written index line does not take the rest of the index with it', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('s1', body('good line'), 'text/plain');
    const file = path.join(dir, sessionDirName('s1'), SESSION_BODIES_INDEX);
    await fs.appendFile(file, '{"sha":"half-writ');
    const fresh = new BlobStore(dir);
    assert.ok(await fresh.hasBody('s1', sha!), 'the intact line should still be read');
    assert.equal((await fresh.sweep(0)).removed, 0);
  });
});

describe('reading an index back', () => {
  test('a restart finds the bodies the previous process stored', async () => {
    const first = new BlobStore(dir);
    const sha = await first.putBody('s1', body('survives a restart'), 'text/plain');
    const second = new BlobStore(dir);
    assert.ok(await second.hasBody('s1', sha!));
    assert.equal(String(await second.read(sha!)), 'survives a restart');
  });

  test('the budget after a restart counts what is already there', async () => {
    const first = new BlobStore(dir, 30);
    await first.putBody('s1', Buffer.alloc(25, 'a'), 'text/plain');
    const second = new BlobStore(dir, 30);
    assert.equal(await second.putBody('s1', Buffer.alloc(10, 'b'), 'text/plain'), null);
  });

  test('a session with files but no bodies reads cleanly, and the reverse', async () => {
    const blobs = new BlobStore(dir);
    await blobs.put('s1', 'https://app.test/only.js', body('a file'), 'text/javascript');
    await blobs.putBody('s2', body('a body'), 'text/plain');
    assert.equal((await blobs.list('s1')).length, 1);
    assert.equal((await blobs.list('s2')).length, 0);
    assert.equal((await blobs.sweep(0)).removed, 0);
    assert.ok(await fs.stat(path.join(dir, sessionDirName('s1'), SESSION_FILES_INDEX)));
  });
});

describe('deciding what to move', () => {
  const response = (over: Record<string, unknown> = {}) =>
    ({ type: 'network.response', ts: 1, requestId: 'r1', status: 200, statusText: 'OK', headers: {}, ...over }) as never;
  const request = (over: Record<string, unknown> = {}) =>
    ({ type: 'network.request', ts: 1, requestId: 'r1', kind: 'fetch', method: 'POST', url: 'http://x/', headers: {}, ...over }) as never;

  test('a small body stays where it is: a hash would cost more than the body', () => {
    assert.equal(bodyOf(response({ body: 'x'.repeat(100) })), null);
    assert.equal(bodyOf(response({ body: '' })), null);
    assert.equal(bodyOf(response({})), null);
    assert.equal(bodyOf(response({ body: null })), null);
  });

  test('a base64 body is stored as the bytes it stands for, not as its characters', () => {
    const raw = Buffer.alloc(4000, 0xff);
    const held = bodyOf(response({ body: raw.toString('base64'), bodyEncoding: 'base64', mimeType: 'image/png' }));
    assert.ok(held);
    assert.deepEqual(held.bytes, raw, 'base64 was stored as text and the bytes came back wrong');
    assert.equal(held.mime, 'image/png');
  });

  test('a text body round-trips as utf-8, so a non-ASCII payload is not mangled', () => {
    const text = 'çafé — naïve ☕ '.repeat(500);
    const held = bodyOf(response({ body: text, mimeType: 'application/json' }));
    assert.ok(held);
    assert.equal(held.bytes.toString('utf8'), text);
    assert.ok(held.bytes.length > text.length, 'bytes, not characters');
  });

  test('a request takes its type from its headers, however they are spelled', () => {
    const held = bodyOf(request({ body: 'a'.repeat(3000), headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    assert.equal(held?.mime, 'application/json');
    assert.equal(bodyOf(request({ body: 'a'.repeat(3000), headers: {} }))?.mime, '');
  });

  test('only the two event types that have a body are considered', () => {
    assert.equal(carriesBody(response()), true);
    assert.equal(carriesBody(request()), true);
    assert.equal(carriesBody({ type: 'network.finished', ts: 1, requestId: 'r1', durationMs: 5 } as never), false);
  });

  test('the swapped event keeps the size and loses the body, and nothing else', () => {
    const before = response({ body: 'y'.repeat(5000), mimeType: 'application/json', status: 404, waitMs: 12 });
    const after = withBodyRef(before, 'a'.repeat(64), 5000) as Record<string, unknown>;
    assert.equal(after.body, undefined);
    assert.equal(after.bodyRef, 'a'.repeat(64));
    assert.equal(after.bodyBytes, 5000);
    assert.equal(after.status, 404, 'the rest of the event must survive');
    assert.equal(after.waitMs, 12);
    assert.equal(after.mimeType, 'application/json');
  });
});

describe('sweeping while a run is still storing', () => {
  test('a blob written during a sweep is not taken by it', async () => {
    // A blob is on disk before the index line that claims it, so for that
    // moment it looks exactly like an orphan. Deleting one recording while
    // another is still collecting used to land in that window — and the loss
    // only showed up when someone opened the file weeks later.
    const blobs = new BlobStore(dir);
    await blobs.put('other', 'http://x/a.js', body('another run'), 'text/javascript');

    const stored = blobs.putBody('live', body('just arrived'), 'text/plain');
    const swept = blobs.sweep();
    const [sha] = await Promise.all([stored, swept]);
    await blobs.whenQuiet('live');

    assert.equal(String(await blobs.read(sha!)), 'just arrived');
    assert.ok(await blobs.hasBody('live', sha!), 'and its line should still find it');
  });

  test('once its line has landed, the next sweep keeps it for the reference, not the grace', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('live', body('settled'), 'text/plain');
    // grace 0: judged purely on whether anything points at it.
    assert.equal((await blobs.sweep(0)).removed, 0);
    assert.equal(String(await blobs.read(sha!)), 'settled');
  });

  test('an orphan older than the grace is still collected', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('gone', body('orphan'), 'text/plain');
    await fs.rm(path.join(dir, sessionDirName('gone')), { recursive: true });
    blobs.forget('gone');
    assert.equal((await blobs.sweep()).removed, 0, 'too young to judge yet');
    assert.equal((await blobs.sweep(0)).removed, 1, 'and collected once it is old enough');
    assert.equal(await blobs.read(sha!), null);
  });
});
