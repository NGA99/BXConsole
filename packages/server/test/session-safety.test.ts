/**
 * What survives a restart, a crash and a delete.
 *
 * A recording is the whole product: it is read weeks after the page that
 * made it is gone, and there is no second chance to collect it. The failures
 * pinned here are the quiet ones — a restart that renumbers events so the
 * merge reads them out of order, a half-written line that takes the rest of a
 * file with it, a delete that frees bytes another recording still points at.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SESSION_FILES, SESSION_BODIES_INDEX, SESSION_FILES_INDEX, sessionDirName } from '@bxconsole/protocol';
import { SessionStore } from '../src/store';
import { SessionRegistry } from '../src/registry';
import { BlobStore } from '../src/blobs';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-safety-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const meta = (sessionId: string, over: Record<string, unknown> = {}) =>
  ({
    sessionId,
    name: 'run',
    url: 'http://app.test/',
    title: 'app',
    userAgent: 'test',
    viewport: { width: 800, height: 600, dpr: 1 },
    startedAt: 1000,
    lastSeenAt: 1000,
    connected: false,
    tabs: [],
    ...over,
  }) as never;

const event = (seq: number) =>
  ({ seq, tabId: 't1', event: { type: 'console.message', ts: seq, level: 'log', args: [] } }) as never;

const fileFor = (sessionId: string, name: string) => path.join(dir, sessionDirName(sessionId), name);

describe('restarting the relay', () => {
  test('sequence numbers continue instead of starting over', async () => {
    const first = new SessionStore(dir);
    await first.writeMeta(meta('s1'));
    for (const n of [1, 2, 3]) await first.appendEvent('s1', event(n));

    // A fresh process, reading what the last one left.
    const second = new SessionStore(dir);
    const registry = new SessionRegistry(second);
    await registry.loadFromDisk();
    const entry = registry.get('s1')!;
    assert.equal(registry.nextSeq(entry), 4, 'a restart that renumbers makes the merge read events out of order');
  });

  test('a run that was live when the relay stopped is listed as disconnected', async () => {
    const store = new SessionStore(dir);
    await store.writeMeta(meta('s1', { connected: true, tabs: [{ tabId: 't1', url: 'u', title: 't', viewport: { width: 1, height: 1, dpr: 1 }, startedAt: 1, lastSeenAt: 1, connected: true }] }));
    const registry = new SessionRegistry(new SessionStore(dir));
    await registry.loadFromDisk();
    const m = registry.get('s1')!.meta;
    assert.equal(m.connected, false, 'nothing is connected to a process that just started');
    assert.equal(m.tabs[0]!.connected, false);
  });

  test('a half-written meta.json loses that one run, not the listing', async () => {
    const store = new SessionStore(dir);
    await store.writeMeta(meta('good'));
    await fs.mkdir(path.join(dir, sessionDirName('broken')), { recursive: true });
    await fs.writeFile(fileFor('broken', SESSION_FILES.meta), '{"sessionId":"brok');
    const registry = new SessionRegistry(new SessionStore(dir));
    await registry.loadFromDisk();
    assert.deepEqual(registry.all().map((m) => m.sessionId), ['good']);
  });

  test('a stored body is found again, and still counts against the budget', async () => {
    const before = new BlobStore(dir, 100);
    const sha = await before.putBody('s1', Buffer.alloc(80, 'a'), 'application/json');
    const after = new BlobStore(dir, 100);
    assert.ok(await after.hasBody('s1', sha!), 'a restart must not forget what it is holding');
    assert.equal(await after.putBody('s1', Buffer.alloc(40, 'b'), 'text/plain'), null, 'the budget has to count what is already there');
  });
});

describe('a crash in the middle of writing', () => {
  test('a torn last line does not take the lines before it', async () => {
    const store = new SessionStore(dir);
    await store.writeMeta(meta('s1'));
    for (const n of [1, 2]) await store.appendEvent('s1', event(n));
    await fs.appendFile(fileFor('s1', SESSION_FILES.console), '{"seq":3,"event":{"type":"con');

    const read: number[] = [];
    for await (const chunk of new SessionStore(dir).readHistory('s1')) for (const e of chunk) read.push(e.seq);
    assert.deepEqual(read, [1, 2], 'the intact events must still come back');
  });

  test('a torn blob index line does not lose the files recorded before it', async () => {
    const blobs = new BlobStore(dir);
    await blobs.put('s1', 'http://app.test/a.js', Buffer.from('kept'), 'text/javascript');
    await fs.appendFile(fileFor('s1', SESSION_FILES_INDEX), '{"url":"http://app.test/b.js","sh');
    const fresh = new BlobStore(dir);
    assert.equal((await fresh.list('s1')).length, 1);
    assert.equal((await fresh.sweep(0)).removed, 0, 'and the sweep must not read the loss as an orphan');
  });

  test('a part-file left by a killed write is not mistaken for an orphan blob', async () => {
    const blobs = new BlobStore(dir);
    await blobs.putBody('s1', Buffer.from('real'), 'text/plain');
    const stray = path.join(dir, 'blobs', 'ff', 'ee', `${'f'.repeat(64)}.12345.part`);
    await fs.mkdir(path.dirname(stray), { recursive: true });
    await fs.writeFile(stray, 'half a file');
    await blobs.sweep(0);
    assert.ok(await fs.stat(stray), 'a write in flight is not rubbish');
  });
});

describe('deleting a run', () => {
  test('its directory goes, and nothing else does', async () => {
    const store = new SessionStore(dir);
    const registry = new SessionRegistry(store);
    await store.writeMeta(meta('doomed'));
    await store.writeMeta(meta('kept'));
    await registry.loadFromDisk();
    assert.equal(await registry.forget('doomed'), true);
    assert.deepEqual(registry.all().map((m) => m.sessionId), ['kept']);
    await assert.rejects(fs.stat(path.join(dir, sessionDirName('doomed'))));
    assert.ok(await fs.stat(path.join(dir, sessionDirName('kept'))));
  });

  test('bytes another run still points at are not freed with it', async () => {
    const blobs = new BlobStore(dir);
    const store = new SessionStore(dir);
    const registry = new SessionRegistry(store);
    let swept: Promise<void> = Promise.resolve();
    // The relay does not await this: deleting a recording should not wait on
    // a walk of every session. The test does, because it is checking what the
    // walk decides, not when.
    registry.onRemoved = (id) => {
      blobs.forget(id);
      swept = blobs.sweep(0).then(() => undefined);
      return swept;
    };
    await store.writeMeta(meta('doomed'));
    await store.writeMeta(meta('kept'));
    await registry.loadFromDisk();

    const shared = Buffer.from('a bundle both runs loaded');
    const only = Buffer.from('only the doomed run saw this');
    await blobs.put('doomed', 'http://app.test/vendor.js', shared, 'text/javascript');
    await blobs.put('kept', 'http://app.test/vendor.js', shared, 'text/javascript');
    const lonely = await blobs.put('doomed', 'http://app.test/once.js', only, 'text/javascript');
    const together = await blobs.lookup('kept', 'http://app.test/vendor.js');

    await registry.forget('doomed');
    await swept;
    assert.ok(await blobs.read(together!.sha), 'the surviving run must still be readable');
    assert.equal(await blobs.read(lonely!.sha), null, 'and the bytes nothing points at should go');
  });

  test('a deleted run cannot be read back through the body route’s check', async () => {
    const blobs = new BlobStore(dir);
    const sha = await blobs.putBody('gone', Buffer.from('secret'), 'text/plain');
    await fs.rm(path.join(dir, sessionDirName('gone')), { recursive: true });
    blobs.forget('gone');
    assert.equal(await blobs.hasBody('gone', sha!), null);
  });
});

describe('the trash', () => {
  test('trashing keeps the recording and only moves the row', async () => {
    const store = new SessionStore(dir);
    const registry = new SessionRegistry(store);
    await store.writeMeta(meta('s1'));
    await store.appendEvent('s1', event(1));
    await registry.loadFromDisk();

    assert.equal(await registry.setTrashed('s1', true), true);
    assert.ok(registry.get('s1')!.meta.trashedAt, 'the row should be marked');
    const kept: number[] = [];
    for await (const chunk of store.readHistory('s1')) for (const e of chunk) kept.push(e.seq);
    assert.deepEqual(kept, [1], 'the recording itself must be untouched');

    await registry.setTrashed('s1', false);
    assert.equal(registry.get('s1')!.meta.trashedAt, undefined);
  });

  test('a trashed run that talks again comes back out of the trash', async () => {
    const store = new SessionStore(dir);
    const registry = new SessionRegistry(store);
    await store.writeMeta(meta('s1'));
    await registry.loadFromDisk();
    await registry.setTrashed('s1', true);
    await registry.upsertFromHello(
      { sessionId: 's1', tabId: 't1', tabStartedAt: 1, name: 'run', url: 'u', title: 't', userAgent: 'x', viewport: { width: 1, height: 1, dpr: 1 }, startedAt: 1 } as never,
      { readyState: 1, OPEN: 1, close() {} } as never,
    );
    assert.equal(registry.get('s1')!.meta.trashedAt, undefined, 'activity means the run is in use');
  });

  test('the trashed mark survives a restart', async () => {
    const store = new SessionStore(dir);
    const registry = new SessionRegistry(store);
    await store.writeMeta(meta('s1'));
    await registry.loadFromDisk();
    await registry.setTrashed('s1', true);

    const reloaded = new SessionRegistry(new SessionStore(dir));
    await reloaded.loadFromDisk();
    assert.ok(reloaded.get('s1')!.meta.trashedAt);
  });
});

describe('session ids that are not ids', () => {
  for (const bad of ['../escape', 'a/b', '', '.', '..', 'x'.repeat(65), 'has space', 'nul\0byte']) {
    test(`${JSON.stringify(bad)} is refused before it reaches the filesystem`, () => {
      const store = new SessionStore(dir);
      assert.throws(() => store.dirFor(bad));
    });
  }
});
