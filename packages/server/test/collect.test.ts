/**
 * Eager collection fetches from someone else's page. Everything worth pinning
 * here is a restraint: what it refuses to ask for, how few it asks at once,
 * and that it never asks twice. Getting those wrong does not show up as a bug
 * in this console — it shows up as load on a service someone else runs.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AssetData } from '@bxconsole/protocol';
import { BlobStore } from '../src/blobs';
import { AssetCollector, wanted } from '../src/collect';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-collect-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A page that answers with a body for anything asked of it, and counts the asks. */
function fakePage(over: (url: string) => AssetData | null = () => null) {
  const asked: string[] = [];
  let live = 0;
  let peak = 0;
  const fetchAsset = async (_s: string, url: string, _t?: string): Promise<AssetData | null> => {
    asked.push(url);
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return over(url) ?? { url, status: 200, body: Buffer.from(`/* ${url} */`).toString('base64'), mimeType: 'text/javascript' };
  };
  return { fetchAsset, asked, peak: () => peak };
}

const NOW = () => new AssetCollector(new BlobStore(dir), fakePage().fetchAsset, { settleMs: 0 });

describe('what it will even consider', () => {
  test('code and markup, yes', () => {
    for (const u of ['https://app.test/main.js', 'https://app.test/a.css', 'https://app.test/i.html', 'https://app.test/d.json', 'https://app.test/m.js.map']) {
      assert.equal(wanted(u), true, u);
    }
  });

  test('pictures, media and fonts, no — the Screen fetches those when it needs them', () => {
    for (const u of ['https://app.test/hero.png', 'https://app.test/clip.mp4', 'https://app.test/i.woff2', 'https://app.test/a.jpg']) {
      assert.equal(wanted(u), false, u);
    }
  });

  test('an extensionless path is left alone: a document and an API route look identical here', () => {
    assert.equal(wanted('https://app.test/api/orders'), false);
    assert.equal(wanted('https://app.test/'), false);
  });

  test('our own traffic is not the page’s', () => {
    assert.equal(wanted('http://relay.test/agent.js'), false);
    assert.equal(wanted('http://relay.test/asset/abc/ZGVm'), false);
    assert.equal(wanted('http://relay.test/ping/img/tok123'), false);
  });

  test('non-http schemes cannot be fetched and are not offered', () => {
    assert.equal(wanted('data:text/javascript,1'), false);
    assert.equal(wanted('blob:https://app.test/x'), false);
    assert.equal(wanted('not a url at all'), false);
  });
});

describe('asking the page', () => {
  test('a url offered many times is fetched once', async () => {
    const page = fakePage();
    const c = new AssetCollector(new BlobStore(dir), page.fetchAsset, { settleMs: 0 });
    for (let i = 0; i < 5; i++) c.offer('s1', 'https://app.test/main.js', 't1');
    await c.whenIdle();
    assert.deepEqual(page.asked, ['https://app.test/main.js']);
  });

  test('a url already in the store is not asked for again', async () => {
    const blobs = new BlobStore(dir);
    await blobs.put('s1', 'https://app.test/main.js', Buffer.from('held'), 'text/javascript');
    const page = fakePage();
    const c = new AssetCollector(blobs, page.fetchAsset, { settleMs: 0 });
    c.offer('s1', 'https://app.test/main.js', 't1');
    await c.whenIdle();
    assert.deepEqual(page.asked, [], 'the bytes were already on disk');
  });

  test('a failure is not retried: the page is not asked the same question forever', async () => {
    const page = fakePage(() => ({ url: 'x', error: 'opaque response (no CORS)' }));
    const c = new AssetCollector(new BlobStore(dir), page.fetchAsset, { settleMs: 0 });
    c.offer('s1', 'https://cdn.test/lib.js', 't1');
    await c.whenIdle();
    c.offer('s1', 'https://cdn.test/lib.js', 't1');
    await c.whenIdle();
    assert.equal(page.asked.length, 1);
  });

  test('no more than a few at a time, however many the page loads', async () => {
    const page = fakePage();
    const c = new AssetCollector(new BlobStore(dir), page.fetchAsset, { settleMs: 0, concurrency: 3 });
    for (let i = 0; i < 40; i++) c.offer('s1', `https://app.test/chunk-${i}.js`, 't1');
    await c.whenIdle();
    assert.equal(page.asked.length, 40);
    assert.ok(page.peak() <= 3, `peaked at ${page.peak()} concurrent fetches`);
  });

  test('what it fetched is in the store, readable afterwards', async () => {
    const blobs = new BlobStore(dir);
    const c = new AssetCollector(blobs, fakePage().fetchAsset, { settleMs: 0 });
    c.offer('s1', 'https://app.test/main.js', 't1');
    await c.whenIdle();
    await blobs.whenQuiet('s1');
    const record = await blobs.lookup('s1', 'https://app.test/main.js');
    assert.ok(record, 'nothing was stored');
    assert.equal(record.kind, 'keep');
    assert.match(String(await blobs.read(record.sha)), /main\.js/);
  });

  test('one busy run does not starve a quiet one', async () => {
    const page = fakePage();
    const c = new AssetCollector(new BlobStore(dir), page.fetchAsset, { settleMs: 0, concurrency: 1 });
    for (let i = 0; i < 6; i++) c.offer('busy', `https://busy.test/${i}.js`, 't1');
    c.offer('quiet', 'https://quiet.test/only.js', 't1');
    await c.whenIdle();
    const at = page.asked.indexOf('https://quiet.test/only.js');
    assert.ok(at >= 0 && at < 3, `the quiet run waited behind ${at} others`);
  });
});

describe('knowing when to stop', () => {
  test('a session past its budget is dropped rather than asked for more', async () => {
    const blobs = new BlobStore(dir, 40);
    const page = fakePage();
    const c = new AssetCollector(blobs, page.fetchAsset, { settleMs: 0, concurrency: 1 });
    for (let i = 0; i < 10; i++) c.offer('s1', `https://app.test/chunk-${i}.js`, 't1');
    await c.whenIdle();
    await blobs.whenQuiet('s1');
    assert.ok(page.asked.length < 10, `kept asking past the budget: ${page.asked.length} fetches`);
    let stored = 0;
    for (const r of await blobs.list('s1')) stored += r.bytes;
    assert.ok(stored <= 40, `stored ${stored} bytes against a budget of 40`);
  });

  test('a run whose last window closed stops being collected for', async () => {
    const page = fakePage();
    const c = new AssetCollector(new BlobStore(dir), page.fetchAsset, { settleMs: 20 });
    for (let i = 0; i < 10; i++) c.offer('s1', `https://app.test/${i}.js`, 't1');
    c.forget('s1');
    await c.whenIdle();
    assert.deepEqual(page.asked, []);
    assert.equal(c.pending(), 0);
  });

  test('a long run stops remembering urls rather than growing without end', async () => {
    const page = fakePage();
    const c = new AssetCollector(new BlobStore(dir), page.fetchAsset, { settleMs: 0, maxTracked: 5 });
    for (let i = 0; i < 50; i++) c.offer('s1', `https://app.test/${i}.js`, 't1');
    await c.whenIdle();
    assert.equal(page.asked.length, 5);
  });

  test('a page that throws on being asked does not take the collector down', async () => {
    const c = new AssetCollector(
      new BlobStore(dir),
      async () => {
        throw new Error('socket gone');
      },
      { settleMs: 0 },
    );
    c.offer('s1', 'https://app.test/main.js', 't1');
    await assert.doesNotReject(c.whenIdle());
  });
});

describe('waiting for the load to settle', () => {
  test('a burst is one round of fetching, started after it stops', async () => {
    const page = fakePage();
    const c = new AssetCollector(new BlobStore(dir), page.fetchAsset, { settleMs: 30 });
    c.offer('s1', 'https://app.test/a.js', 't1');
    await new Promise((r) => setTimeout(r, 10));
    c.offer('s1', 'https://app.test/b.js', 't1');
    assert.deepEqual(page.asked, [], 'fetched during the page load');
    await c.whenIdle();
    assert.equal(page.asked.length, 2);
  });
});
