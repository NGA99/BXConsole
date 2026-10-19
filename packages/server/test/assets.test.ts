/**
 * The asset proxy's URL handling.
 *
 * What is pinned here is what the mirror cannot survive being wrong about: a
 * URL has to survive the round trip unchanged, a stylesheet's own references
 * have to end up pointing back at the proxy rather than at a path that does
 * not exist, and the decoder has to refuse schemes that would turn the relay
 * into a file server for whoever asks.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetCache } from '../src/assets';
import { BlobStore } from '../src/blobs';
import { assetPath, decodeAssetUrl, isProxyableUrl, rewriteCssUrls, rewriteSrcset } from '@bxconsole/protocol';

const SESSION = 'abc123';
/** The console's side of the contract, written the way the mirror writes it. */
const toProxy = (abs: string) => assetPath(SESSION, abs);
const encodedOf = (p: string) => p.split('/')[3]!;

describe('asset urls', () => {
  test('a url survives encode and decode', () => {
    for (const url of [
      'http://intranet.example/img/logo.png',
      'https://host:8443/a%20b/c.css?v=1#frag',
      'http://café.example/imagé.png',
      'https://x/y?q=a+b&r=c/d',
    ]) {
      assert.equal(decodeAssetUrl(encodedOf(assetPath(SESSION, url))), new URL(url).href);
    }
  });

  test('the session id is escaped into the path', () => {
    assert.ok(assetPath('a-b_c', 'http://x/').startsWith('/asset/a-b_c/'));
  });

  test('the window to ask rides in the query', () => {
    const url = 'http://b.example/pic.png';
    assert.equal(assetPath(SESSION, url, { tabId: 'win2' }).split('?')[1], 'tab=win2');
    assert.equal(assetPath(SESSION, url, { tabId: 'win2', fallback: false }).split('?')[1], 'tab=win2&nofallback=1');
    assert.ok(!assetPath(SESSION, url).includes('?'));
    // The encoded url is untouched by the query.
    assert.equal(decodeAssetUrl(assetPath(SESSION, url, { tabId: 'win2' }).split('/')[3]!.split('?')[0]!), url);
  });

  test('fallback can be refused, and the url still decodes', () => {
    const url = 'http://intranet.example/favicon.ico';
    const p = assetPath(SESSION, url, { fallback: false });
    assert.ok(p.endsWith('?nofallback=1'));
    assert.equal(decodeAssetUrl(p.split('/')[3]!.split('?')[0]!), url);
    assert.ok(!assetPath(SESSION, url).includes('nofallback'));
    assert.ok(!assetPath(SESSION, url, { fallback: true }).includes('nofallback'));
  });

  test('only fetchable schemes come back', () => {
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    assert.equal(decodeAssetUrl(enc('file:///etc/passwd')), null);
    assert.equal(decodeAssetUrl(enc('data:text/html,<b>')), null);
    assert.equal(decodeAssetUrl(enc('javascript:alert(1)')), null);
    assert.equal(decodeAssetUrl(enc('not a url')), null);
    assert.equal(decodeAssetUrl('!!!not base64!!!'), null);
    assert.ok(decodeAssetUrl(enc('http://x/y'))?.startsWith('http://'));
  });

  test('what is worth proxying', () => {
    assert.ok(isProxyableUrl('/a.png'));
    assert.ok(isProxyableUrl('https://x/a.png'));
    assert.ok(!isProxyableUrl(''));
    assert.ok(!isProxyableUrl('   '));
    assert.ok(!isProxyableUrl('#gradient'));
    assert.ok(!isProxyableUrl('data:image/png;base64,AAA'));
    assert.ok(!isProxyableUrl('javascript:void 0'));
  });
});

describe('css rewriting', () => {
  const base = 'http://intranet.example/css/site.css';

  test('url() is resolved against the stylesheet, not the proxy path', () => {
    const out = rewriteCssUrls('a{background:url(../img/bg.png)}', base, toProxy);
    const inner = /url\("([^"]+)"\)/.exec(out)![1]!;
    assert.equal(decodeAssetUrl(encodedOf(inner)), 'http://intranet.example/img/bg.png');
  });

  test('quotes, spacing and @import are all handled', () => {
    const out = rewriteCssUrls(
      `@import "theme.css";\n.a{background:url( 'a.png' )}\n.b{background:url("b.png")}`,
      base,
      toProxy,
    );
    assert.equal(out.match(/\/asset\//g)?.length, 3);
    assert.ok(out.startsWith('@import "/asset/'));
  });

  test('what must be left alone is left alone', () => {
    const css = `.a{background:url(data:image/png;base64,AAA)}.b{fill:url(#grad)}.c{background:url()}`;
    assert.equal(rewriteCssUrls(css, base, toProxy), css);
  });

  test('a rewrite is not applied twice', () => {
    const once = rewriteCssUrls('a{background:url(x.png)}', base, toProxy);
    // The second pass sees an already-proxied path; a console that refuses to
    // wrap its own URLs keeps it stable.
    const twice = rewriteCssUrls(once, base, (abs) => (abs.includes('/asset/') ? null : toProxy(abs)));
    assert.equal(twice, once);
  });
});

describe('srcset rewriting', () => {
  test('each candidate keeps its descriptor', () => {
    const out = rewriteSrcset('a.png 1x, b.png 2x', (raw) => `/p/${raw}`);
    assert.equal(out, '/p/a.png 1x, /p/b.png 2x');
  });

  test('a single url with no descriptor', () => {
    assert.equal(rewriteSrcset('a.png', (raw) => `/p/${raw}`), '/p/a.png');
  });

  test('a candidate the proxy declines is kept as written', () => {
    assert.equal(rewriteSrcset('data:image/png;base64,AAA 1x', () => null), 'data:image/png;base64,AAA 1x');
  });
});

describe('the asset cache', () => {
  // mkdtemp, not a name built from the pid: a run that dies before `after`
  // leaves its directory behind, and the next process to be handed that pid
  // inherits the bytes — which showed up as the budget test keeping one file
  // fewer than it should, once, and never again.
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bsc-assets-'));
  const dirFor = (sessionId: string) => path.join(tmp, sessionId);
  /** The store the cache now keeps its bytes in. */
  const blobs = (maxPerSession = Number.POSITIVE_INFINITY) => new BlobStore(tmp, maxPerSession);
  /** What a session's index accounts for, which is what the budget guards. */
  const keptBytes = async (sessionId: string) => {
    const file = path.join(tmp, `session-${sessionId}`, 'files.ndjson');
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return 0;
    }
    const newest = new Map<string, number>();
    for (const line of text.split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { url: string; bytes: number };
      newest.set(r.url, r.bytes);
    }
    return [...newest.values()].reduce((a, b) => a + b, 0);
  };
  after(() => fs.rm(tmp, { recursive: true, force: true }));

  const png = (n: number) => Buffer.alloc(n, 1).toString('base64');
  /** Counts how often the page was asked, so the negative cache is observable. */
  function pageServing(sizes: Record<string, number>) {
    const asked: string[] = [];
    const fetcher = async (_s: string, url: string) => {
      asked.push(url);
      const size = sizes[url];
      return size === undefined ? { url, error: 'opaque response (no CORS)' } : { url, body: png(size), mimeType: 'image/png' };
    };
    return { asked, fetcher };
  }

  test('what fits is kept, and the budget is never overshot by a concurrent batch', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `http://x/${i}.png`);
    const sizes = Object.fromEntries(urls.map((u) => [u, 100]));
    const { fetcher } = pageServing(sizes);
    const cache = new AssetCache(blobs(450), fetcher, 450);

    // All at once, the way a mirror asks.
    const got = await Promise.all(urls.map((u) => cache.get('budget', u)));
    await cache.whenStored('budget');
    // Every one is served, whether or not it was kept.
    assert.equal(got.filter((a) => a?.body.length === 100).length, 10);
    assert.ok((await keptBytes('budget')) <= 450, 'the budget holds');
    assert.equal(await keptBytes('budget'), 400, 'and four of them fit');
  });

  test('a second ask comes off disk, not off the page', async () => {
    const url = 'http://x/once.png';
    const { asked, fetcher } = pageServing({ [url]: 10 });
    const cache = new AssetCache(
      blobs(), fetcher, 1000);
    await cache.get('disk', url);
    await cache.whenStored('disk');
    const again = await new AssetCache(
      blobs(), fetcher, 1000).get('disk', url);
    assert.equal(again?.body.length, 10);
    assert.equal(asked.length, 1);
  });

  test('the named window is the one asked', async () => {
    const url = 'http://b.example/pic.png';
    const asked: Array<string | undefined> = [];
    const cache = new AssetCache(
      blobs(),
      async (_s, u, tabId) => {
        asked.push(tabId);
        return { url: u, body: png(10), mimeType: 'image/png' };
      },
      1000,
    );
    await cache.get('routed', url, 'win-b');
    assert.deepEqual(asked, ['win-b']);
  });

  test('one window failing does not speak for another', async () => {
    // The case this exists for: a run spanning two origins, where only the
    // window on b.example can read b.example's picture.
    const url = 'http://b.example/pic.png';
    const asked: Array<string | undefined> = [];
    const cache = new AssetCache(
      blobs(),
      async (_s, u, tabId) => {
        asked.push(tabId);
        return tabId === 'win-b'
          ? { url: u, body: png(10), mimeType: 'image/png' }
          : { url: u, error: 'opaque response (no CORS)' };
      },
      1000,
    );
    assert.equal(await cache.get('cross', url, 'win-a'), null);
    assert.equal(await cache.get('cross', url, 'win-a'), null, 'the refusal is remembered for that window');
    assert.equal((await cache.get('cross', url, 'win-b'))?.body.length, 10, 'but the other window still gets a turn');
    assert.deepEqual(asked, ['win-a', 'win-b']);
  });

  test('a file the page cannot read is not asked for again', async () => {
    const url = 'http://cdn/no-cors.png';
    const { asked, fetcher } = pageServing({});
    const cache = new AssetCache(
      blobs(), fetcher, 1000);
    assert.equal(await cache.get('cors', url), null);
    assert.equal(await cache.get('cors', url), null);
    assert.equal(asked.length, 1);
  });

  test('"no window connected" is not remembered: a reload must be able to answer', async () => {
    const url = 'http://x/later.png';
    let connected = false;
    const asked: string[] = [];
    const cache = new AssetCache(
      blobs(),
      async (_s, u) => {
        asked.push(u);
        return connected ? { url: u, body: png(10), mimeType: 'image/png' } : null;
      },
      1000,
    );
    assert.equal(await cache.get('offline', url), null);
    connected = true;
    assert.equal((await cache.get('offline', url))?.body.length, 10);
    assert.equal(asked.length, 2);
  });
});
