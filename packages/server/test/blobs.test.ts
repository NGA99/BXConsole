/**
 * The shared file store.
 *
 * What is pinned here is what the store exists for: a file fetched once is
 * not fetched again, two sessions that saw the same bytes cost one copy, a
 * url whose contents changed between runs reads back as each run saw it, and
 * the sweep frees exactly what nothing refers to any more.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobStore, classify } from '../src/blobs';

const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bsc-blobs-'));
after(() => fs.rm(tmp, { recursive: true, force: true }));

let n = 0;
/** A store of its own, so one test's sweep never touches another's files. */
const freshStore = (maxPerSession?: number) => {
  const root = path.join(tmp, `root${++n}`);
  return { root, store: new BlobStore(root, maxPerSession) };
};
const bytes = (text: string) => Buffer.from(text, 'utf8');

async function countBlobs(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string) => {
    for (const name of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) await walk(full);
      else if (!name.name.endsWith('.part')) total++;
    }
  };
  await walk(path.join(root, 'blobs'));
  return total;
}

describe('what is worth storing', () => {
  test('code and markup are kept; pictures are cached; media is refused', () => {
    for (const mime of ['text/html', 'text/css', 'application/javascript', 'application/json', 'image/svg+xml', 'application/manifest+json']) {
      assert.equal(classify(mime, 1000), 'keep', mime);
    }
    for (const mime of ['image/png', 'image/webp', 'font/woff2']) assert.equal(classify(mime, 1000), 'cache', mime);
    for (const mime of ['video/mp4', 'audio/mpeg']) assert.equal(classify(mime, 1000), 'refuse', mime);
  });

  test('size refuses what type would have allowed', () => {
    // A thirty-megabyte bundle costs as much as a video.
    assert.equal(classify('application/javascript', 100 * 1024 * 1024), 'refuse');
  });

  test('an unlabelled response is treated as readable, not thrown away', () => {
    assert.equal(classify('', 10), 'keep');
  });
});

describe('storing and reading back', () => {
  test('a url a session saw reads back as what it saw', async () => {
    const { store } = freshStore();
    const rec = await store.put('a', 'http://x/app.js', bytes('console.log(1)'), 'application/javascript');
    assert.ok(rec);
    const held = await store.lookup('a', 'http://x/app.js');
    assert.equal(held?.sha, rec!.sha);
    assert.equal((await store.read(rec!.sha))?.toString('utf8'), 'console.log(1)');
  });

  test('a url nobody fetched is simply absent', async () => {
    const { store } = freshStore();
    assert.equal(await store.lookup('a', 'http://x/never.js'), null);
  });

  test('two sessions with the same bytes cost one copy', async () => {
    const { root, store } = freshStore();
    const body = bytes('the same bundle');
    await store.put('one', 'http://x/app.js', body, 'application/javascript');
    await store.put('two', 'http://x/app.js', body, 'application/javascript');
    assert.equal(await countBlobs(root), 1, 'this is the whole point of hashing the contents');
    assert.equal((await store.lookup('one', 'http://x/app.js'))!.sha, (await store.lookup('two', 'http://x/app.js'))!.sha);
  });

  test('the same url with different contents is two files, one per run', async () => {
    // A deploy between runs: keying the cache on the url alone would hand
    // last week's recording this week's code.
    const { root, store } = freshStore();
    await store.put('old', 'http://x/app.js', bytes('version one'), 'application/javascript');
    await store.put('new', 'http://x/app.js', bytes('version two'), 'application/javascript');
    assert.equal(await countBlobs(root), 2);
    assert.equal((await store.read((await store.lookup('old', 'http://x/app.js'))!.sha))?.toString(), 'version one');
    assert.equal((await store.read((await store.lookup('new', 'http://x/app.js'))!.sha))?.toString(), 'version two');
  });

  test('the index survives a restart', async () => {
    const { root, store } = freshStore();
    await store.put('a', 'http://x/app.js', bytes('kept'), 'application/javascript');
    const reopened = new BlobStore(root);
    assert.equal((await reopened.lookup('a', 'http://x/app.js'))?.bytes, 4);
  });
});

describe('the budget', () => {
  test('holds under a concurrent batch, and refuses rather than overshooting', async () => {
    const { store } = freshStore(450);
    const put = Array.from({ length: 10 }, (_, i) => store.put('busy', `http://x/${i}.png`, Buffer.alloc(100, i), 'image/png'));
    const kept = (await Promise.all(put)).filter(Boolean);
    assert.equal(kept.length, 4);
  });

  test('re-storing what a session already has costs nothing', async () => {
    const { store } = freshStore(250);
    const body = bytes('a'.repeat(100));
    for (let i = 0; i < 5; i++) await store.put('same', 'http://x/a.js', body, 'application/javascript');
    assert.ok(await store.lookup('same', 'http://x/a.js'), 'still held after five identical puts');
    assert.ok(await store.put('same', 'http://x/b.js', body, 'application/javascript'), 'and there is room for another');
  });
});

describe('sweeping', () => {
  test('frees what nothing refers to, and keeps what something does', async () => {
    const { root, store } = freshStore();
    await store.put('keeper', 'http://x/kept.js', bytes('still referenced'), 'application/javascript');
    await store.put('goner', 'http://x/gone.js', bytes('about to be orphaned'), 'application/javascript');
    assert.equal(await countBlobs(root), 2);

    // What deleting a session does: the directory goes, the bytes do not.
    await fs.rm(path.join(root, 'session-goner'), { recursive: true, force: true });
    store.forget('goner');
    const swept = await store.sweep(0);
    assert.equal(swept.removed, 1);
    assert.equal(await countBlobs(root), 1);
    assert.ok(await store.read((await store.lookup('keeper', 'http://x/kept.js'))!.sha), 'the surviving session can still read its file');
  });

  test('a sweep with nothing to do is harmless', async () => {
    const { root, store } = freshStore();
    await store.put('a', 'http://x/a.js', bytes('kept'), 'application/javascript');
    assert.deepEqual(await store.sweep(0), { removed: 0, bytes: 0 });
    assert.equal(await countBlobs(root), 1);
    assert.deepEqual(await new BlobStore(path.join(tmp, 'never-used')).sweep(0), { removed: 0, bytes: 0 });
  });
});
