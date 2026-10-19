/**
 * The asset proxy's URL spelling, and the rewriting that keeps a mirrored
 * page looking like itself.
 *
 * Three places have to agree on this: the console builds these URLs, the
 * relay parses them, and the relay writes more of them when it rewrites a
 * stylesheet. When the rewriting is wrong the mirror does not fail — it draws
 * a page with no pictures and the wrong fonts, which reads as the recording
 * being poor rather than the console being broken.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assetPath, decodeAssetUrl, isProxyableUrl, rewriteCssUrls, rewriteSrcset } from '../src/assets';

const proxy = (absolute: string) => `/asset/s1/${Buffer.from(absolute).toString('base64url')}`;
const BASE = 'https://app.test/css/main.css';

describe('the url spelling', () => {
  test('a url survives the round trip exactly', () => {
    for (const url of [
      'https://app.test/a.js',
      'https://app.test/a.js?v=1&x=2#frag',
      'https://app.test/%ED%95%9C%EA%B8%80.css',
      'https://app.test/path with spaces.png',
      'http://192.168.0.9:8080/intranet/app.css',
    ]) {
      const path = assetPath('s1', url);
      const encoded = path.split('/')[3]!;
      assert.equal(decodeAssetUrl(encoded), new URL(url).href, url);
    }
  });

  test('a non-ASCII url survives, which base64 of UTF-16 would not', () => {
    const url = 'https://app.test/café/imagé.png';
    const encoded = assetPath('s1', url).split('/')[3]!;
    assert.equal(decodeAssetUrl(encoded), new URL(url).href);
  });

  test('the encoding is url-safe, so it never needs escaping in a path', () => {
    for (let i = 0; i < 40; i++) {
      const encoded = assetPath('s1', `https://app.test/${'x'.repeat(i)}`).split('/')[3]!;
      assert.doesNotMatch(encoded, /[+/=]/, 'plain base64 would break the path');
    }
  });

  test('the window and the fallback flag ride along only when asked for', () => {
    assert.equal(assetPath('s1', 'https://a.test/x').includes('?'), false);
    assert.match(assetPath('s1', 'https://a.test/x', { tabId: 't1' }), /\?tab=t1$/);
    assert.match(assetPath('s1', 'https://a.test/x', { fallback: false }), /\?nofallback=1$/);
    assert.match(assetPath('s1', 'https://a.test/x', { tabId: 't1', fallback: false }), /\?tab=t1&nofallback=1$/);
    assert.equal(assetPath('s1', 'https://a.test/x', { fallback: true }).includes('nofallback'), false);
  });

  test('a session id is escaped rather than allowed to shape the path', () => {
    assert.ok(!assetPath('../etc', 'https://a.test/x').includes('../'));
  });
});

describe('what the relay will fetch', () => {
  test('only schemes a page can actually be asked for', () => {
    const enc = (s: string) => Buffer.from(s).toString('base64url');
    assert.ok(decodeAssetUrl(enc('https://app.test/a.png')));
    assert.ok(decodeAssetUrl(enc('http://app.test/a.png')));
    assert.ok(decodeAssetUrl(enc('blob:https://app.test/uuid')));
    // Anything else would be the relay lending out something of its own.
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>', 'about:blank', 'ftp://host/x', 'chrome://settings']) {
      assert.equal(decodeAssetUrl(enc(bad)), null, bad);
    }
  });

  test('rubbish decodes to nothing rather than throwing', () => {
    for (const junk of ['', '!!!!', 'not base64 at all', '////', 'aGVsbG8']) {
      assert.doesNotThrow(() => decodeAssetUrl(junk));
      assert.equal(decodeAssetUrl(junk), null, junk);
    }
  });
});

describe('urls found in markup', () => {
  test('the ones worth proxying, and the ones to leave alone', () => {
    assert.equal(isProxyableUrl('/a.png'), true);
    assert.equal(isProxyableUrl('https://cdn.test/a.png'), true);
    assert.equal(isProxyableUrl('  /a.png  '), true);
    for (const leave of ['', '   ', '#anchor', 'data:image/png;base64,AAA', 'about:blank', 'javascript:void 0', 'mailto:a@b.c', 'tel:+1', 'DATA:image/png,x']) {
      assert.equal(isProxyableUrl(leave), false, leave);
    }
  });
});

describe('rewriting a stylesheet', () => {
  test('url() is resolved against the sheet, not against the proxy path', () => {
    // The whole point: a sheet served from /asset/... would resolve its own
    // relative urls against that path, and every image in it would 404.
    const out = rewriteCssUrls('.a{background:url(../img/box.png)}', BASE, proxy);
    assert.match(out, /url\("\/asset\/s1\//);
    assert.equal(decodeAssetUrl(out.match(/\/asset\/s1\/([^"]+)/)![1]!), 'https://app.test/img/box.png');
  });

  test('quotes of either kind, and none at all', () => {
    for (const css of ['url(a.png)', "url('a.png')", 'url("a.png")', 'url(  a.png  )', 'URL(a.png)']) {
      assert.match(rewriteCssUrls(css, BASE, proxy), /url\("\/asset\//, css);
    }
  });

  test('@import is rewritten too, or the sheet it pulls in is lost', () => {
    const out = rewriteCssUrls('@import "theme.css";\n.a{color:red}', BASE, proxy);
    assert.match(out, /@import "\/asset\/s1\//);
    assert.match(out, /\.a\{color:red\}/, 'the rest of the sheet must survive');
  });

  test('what should be left exactly as written is left exactly as written', () => {
    const css = '.a{background:url(data:image/png;base64,AAA)}.b{background:url(#grad)}';
    assert.equal(rewriteCssUrls(css, BASE, proxy), css);
  });

  test('a url the caller declines to proxy is untouched', () => {
    const css = '.a{background:url(keep.png)}';
    assert.equal(rewriteCssUrls(css, BASE, () => null), css);
  });

  test('a url that is not a url does not take the sheet down', () => {
    const css = '.a{background:url(http://[)}';
    assert.doesNotThrow(() => rewriteCssUrls(css, BASE, proxy));
    assert.equal(rewriteCssUrls(css, BASE, proxy), css);
  });

  test('a quote inside a rewritten url cannot break out of the declaration', () => {
    const out = rewriteCssUrls('.a{background:url(a.png)}', BASE, () => 'he"re');
    assert.equal(out, '.a{background:url("he%22re")}');
  });

  test('several urls in one sheet are all rewritten', () => {
    const out = rewriteCssUrls('@import "a.css"; .x{background:url(b.png)} .y{background:url(c.png)}', BASE, proxy);
    assert.equal(out.match(/\/asset\/s1\//g)?.length, 3);
  });
});

describe('rewriting a srcset', () => {
  test('each candidate keeps its descriptor', () => {
    const out = rewriteSrcset('a.png 1x, b.png 2x', (u) => `/p/${u}`);
    assert.equal(out, '/p/a.png 1x, /p/b.png 2x');
  });

  test('width descriptors too', () => {
    assert.equal(rewriteSrcset('s.jpg 480w, l.jpg 1024w', (u) => `/p/${u}`), '/p/s.jpg 480w, /p/l.jpg 1024w');
  });

  test('a candidate with no descriptor is still a candidate', () => {
    assert.equal(rewriteSrcset('only.png', (u) => `/p/${u}`), '/p/only.png');
    assert.equal(rewriteSrcset('a.png, b.png', (u) => `/p/${u}`), '/p/a.png, /p/b.png');
  });

  test('a url with a space in it ends at the space, as the HTML parser has it', () => {
    // Not a quirk worth working around: a candidate's url runs to the next
    // whitespace and everything after it is the descriptor, so no browser
    // reads this as one url either. Pinned so nobody "fixes" it into
    // disagreeing with Chrome.
    assert.equal(rewriteSrcset('has space.png 1x', (u) => `/p/${u}`), '/p/has space.png 1x');
  });

  test('a comma inside a url does not split it', () => {
    // Splitting on commas is the obvious implementation and it destroys every
    // data: URL — one always has a comma after its media type — and any path
    // that happens to contain one.
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(rewriteSrcset(`${data} 1x`, (u) => (u === data ? '/p/data' : null)), '/p/data 1x');
    assert.equal(rewriteSrcset('a,b.png 2x', (u) => `/p/${u}`), '/p/a,b.png 2x');
    assert.equal(rewriteSrcset(`${data} 1x, real.png 2x`, (u) => `/p/${u}`), `/p/${data} 1x, /p/real.png 2x`);
  });

  test('odd whitespace and stray commas do not produce empty candidates', () => {
    assert.equal(rewriteSrcset('  a.png   1x ,,  b.png  2x  ', (u) => `/p/${u}`), '/p/a.png 1x, /p/b.png 2x');
    assert.equal(rewriteSrcset('', (u) => `/p/${u}`), '');
    assert.equal(rewriteSrcset('   ,, ', (u) => `/p/${u}`), '');
  });

  test('newlines count as whitespace, as the HTML parser has them', () => {
    assert.equal(rewriteSrcset('a.png 1x,\n  b.png 2x', (u) => `/p/${u}`), '/p/a.png 1x, /p/b.png 2x');
  });

  test('a url the caller declines is kept as written, descriptor and all', () => {
    assert.equal(rewriteSrcset('a.png 1x, b.png 2x', (u) => (u === 'a.png' ? '/p/a.png' : null)), '/p/a.png 1x, b.png 2x');
  });
});
