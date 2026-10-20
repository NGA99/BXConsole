/**
 * URLs that arrived from the page under investigation.
 *
 * Every one of these strings is something an agent could be made to send —
 * the agent runs inside the page, so the page can forge a `page.navigated`
 * or a request URL — and the console turns them into links the operator
 * clicks. A scheme that slips through here runs script on the console's own
 * origin, so the interesting cases are not the plain ones but the spellings a
 * browser accepts and a naive check does not see.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkableUrl, isScriptUrl, safeHref, urlScheme } from '../src/devtools-ui/safe-url';

describe('isLinkableUrl', () => {
  test('passes the schemes a page can honestly report', () => {
    for (const url of [
      'http://example.com/',
      'https://example.com/a?b=c#d',
      'https://user:pw@example.com:8443/x',
      'HTTPS://EXAMPLE.COM/',
      'file:///Users/someone/page.html',
      // Dead links, but links: a websocket request that failed gets a Console
      // row like any other, and the row's click handler is the useful part.
      'ws://example.com/socket',
      'wss://example.com/socket',
      // The whole point of showing these is the odd ones: a query full of
      // punctuation, or a path that merely mentions another scheme.
      'https://example.com/redir?to=javascript:alert(1)',
      'https://example.com/#javascript:alert(1)',
    ]) {
      assert.equal(isLinkableUrl(url), true, url);
    }
  });

  test('rejects javascript:, however it is spelled', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'jAvAsCrIpT:alert(document.cookie)',
      // Leading whitespace is stripped by the URL parser before the scheme
      // is read, and so are C0 controls — which `\s` in a regex is not.
      '  javascript:alert(1)',
      '\tjavascript:alert(1)',
      '\njavascript:alert(1)',
      '\r\n javascript:alert(1)',
      '\x00javascript:alert(1)',
      '\x01\x02javascript:alert(1)',
      // Tabs and newlines are removed from anywhere in a URL, so these are
      // live script URLs in an attribute even though they do not read as one.
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\r\nscript:alert(1)',
      'jav\tas\ncript:alert(1)',
    ]) {
      assert.equal(isLinkableUrl(url), false, JSON.stringify(url));
    }
  });

  test('rejects the other schemes that run or stand in for a document', () => {
    for (const url of [
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:MsgBox(1)',
      'VBScript:MsgBox(1)',
      'about:blank',
      'about:srcdoc',
      // A blob URL from the page cannot be opened from this origin anyway,
      // and the only one that could be is a blob the console itself made.
      'blob:https://example.com/9f8e-1111',
      'view-source:https://example.com/',
      'mailto:someone@example.com',
      'tel:+15550100',
      'chrome://settings',
      'ftp://example.com/x',
    ]) {
      assert.equal(isLinkableUrl(url), false, url);
    }
  });

  test('rejects anything without one of those schemes', () => {
    // A relative URL would resolve against the console's own origin, which is
    // never where a debugged page's file lives, so it is not a link either.
    // `example.com:8080/x` is in here because a URL parser reads `example.com`
    // as the scheme, not as a host — one more reason this is an allow-list.
    for (const url of [
      '',
      '   ',
      '/path/only',
      'example.com/x',
      'example.com:8080/x',
      '#fragment',
      '//example.com/x',
      'C:\\page.html',
      // Both of these turn up in real stack traces, and both used to render
      // as a relative link into the relay's own origin.
      '<anonymous>',
      'webpack-internal:///./src/app.js',
    ]) {
      assert.equal(isLinkableUrl(url), false, JSON.stringify(url));
    }
  });
});

describe('safeHref', () => {
  test('hands back the URL untouched when it is linkable', () => {
    // Untouched matters: the operator is reading these as evidence, so the
    // href must be the string the page sent, not a normalized version of it.
    const url = 'https://example.com/a?b=%20c&d=e#f';
    assert.equal(safeHref(url), url);
  });

  test('is undefined for anything else, so the attribute is left off', () => {
    assert.equal(safeHref('javascript:alert(1)'), undefined);
    assert.equal(safeHref('data:text/html,x'), undefined);
    assert.equal(safeHref(''), undefined);
  });
});

describe('isScriptUrl', () => {
  test('catches the two schemes that execute, in their odd spellings too', () => {
    for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', '\x00javascript:x', 'java\tscript:x', 'vbscript:x']) {
      assert.equal(isScriptUrl(url), true, JSON.stringify(url));
    }
  });

  test('leaves alone what a mirrored page legitimately contains', () => {
    // The mirror asks this question instead of the allow-list because a
    // `data:` image or a relative path is ordinary markup: dropping those
    // would misrepresent the page the operator is looking at.
    for (const url of [
      'data:image/png;base64,iVBORw0KGgo=',
      '/logo.png',
      'logo.png',
      'https://example.com/logo.png',
      'blob:https://example.com/9f8e',
      'about:blank',
      '#anchor',
      '',
    ]) {
      assert.equal(isScriptUrl(url), false, JSON.stringify(url));
    }
  });
});

describe('urlScheme', () => {
  test('reads the scheme a browser would act on', () => {
    assert.equal(urlScheme('https://example.com'), 'https:');
    assert.equal(urlScheme('HTTPS://example.com'), 'https:');
    assert.equal(urlScheme('ftp://example.com'), 'ftp:');
    assert.equal(urlScheme('custom-app.v2+x://go'), 'custom-app.v2+x:');
    assert.equal(urlScheme('java\tscript:x'), 'javascript:');
    assert.equal(urlScheme('\x00\x20javascript:x'), 'javascript:');
  });

  test('is null when there is none', () => {
    assert.equal(urlScheme('/relative'), null);
    assert.equal(urlScheme('9lives:x'), null, 'a scheme cannot start with a digit');
    assert.equal(urlScheme(''), null);
  });

  test('reads a bare host:port as a scheme, as the URL parser does', () => {
    // Not a quirk worth fixing: `example.com:8080/x` really is a URL with the
    // scheme `example.com`, which is why the callers above ask whether the
    // scheme is one of three rather than whether it is one of the bad ones.
    assert.equal(urlScheme('example.com:8080/x'), 'example.com:');
  });
});
