/**
 * Reading a user agent.
 *
 * On a blind XSS run this is most of what is known about whose browser ran
 * the payload, so being wrong here is not cosmetic — it misdescribes the
 * finding. Every Chromium browser claims to be both Chrome and Safari, which
 * is the trap this exists to avoid falling into.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { browserInfo, browserLabel, platformLabel } from '../src/panels/sessions/browser-info';

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.2912.93',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
};

describe('which browser', () => {
  test('Chrome is Chrome', () => {
    assert.equal(browserInfo(UA.chromeMac).browser, 'Chrome');
    assert.equal(browserInfo(UA.chromeMac).version, '155');
  });

  test('Edge is not Chrome, though it says it is', () => {
    // The Edge string contains "Chrome/144" and "Safari/537.36" in full.
    assert.equal(browserInfo(UA.edge).browser, 'Edge');
    assert.equal(browserInfo(UA.edge).version, '144');
  });

  test('Opera is not Chrome either', () => {
    assert.equal(browserInfo(UA.opera).browser, 'Opera');
    assert.equal(browserInfo(UA.opera).version, '125');
  });

  test('Samsung Internet is not Chrome either', () => {
    assert.equal(browserInfo(UA.samsung).browser, 'Samsung Internet');
    assert.equal(browserInfo(UA.samsung).version, '27');
  });

  test('Safari is only Safari when nothing else claimed it', () => {
    assert.equal(browserInfo(UA.safariMac).browser, 'Safari');
    assert.equal(browserInfo(UA.safariMac).version, '18');
    // Chrome's string ends in "Safari/537.36" too, and must not match.
    assert.equal(browserInfo(UA.chromeMac).browser, 'Chrome');
  });

  test('Firefox', () => {
    assert.equal(browserInfo(UA.firefox).browser, 'Firefox');
    assert.equal(browserInfo(UA.firefox).version, '142');
  });

  test('something unrecognised says so rather than guessing', () => {
    const got = browserInfo('curl/8.4.0');
    assert.equal(got.browser, 'Unknown');
    assert.equal(got.version, null);
  });
});

describe('which platform', () => {
  test('desktops', () => {
    assert.equal(browserInfo(UA.chromeMac).os, 'macOS');
    assert.equal(browserInfo(UA.chromeWin).os, 'Windows 10/11');
    assert.equal(browserInfo(UA.firefox).os, 'Linux');
    assert.equal(browserInfo(UA.chromeOs).os, 'ChromeOS');
  });

  test('Windows 11 is not claimed, because the string cannot tell', () => {
    // Windows 11 reports NT 10.0 and always has.
    assert.match(String(browserInfo(UA.chromeWin).os), /10\/11/);
  });

  test('phones carry their OS version', () => {
    assert.equal(browserInfo(UA.chromeAndroid).os, 'Android 14');
    assert.equal(browserInfo(UA.safariIos).os, 'iOS 18');
  });

  test('a phone is marked as one', () => {
    assert.equal(browserInfo(UA.chromeAndroid).mobile, true);
    assert.equal(browserInfo(UA.safariIos).mobile, true);
    assert.equal(browserInfo(UA.chromeMac).mobile, false);
    assert.equal(browserInfo(UA.chromeWin).mobile, false);
  });

  test('ChromeOS is not read as plain Linux, though it contains X11', () => {
    assert.equal(browserInfo(UA.chromeOs).os, 'ChromeOS');
  });
});

describe('what the row says', () => {
  test('name and major version', () => {
    assert.equal(browserLabel(browserInfo(UA.chromeMac)), 'Chrome 155');
    assert.equal(browserLabel(browserInfo(UA.edge)), 'Edge 144');
  });

  test('a phone says so in the name', () => {
    assert.equal(browserLabel(browserInfo(UA.chromeAndroid)), 'Chrome Mobile 144');
  });

  test('no version, no number', () => {
    assert.equal(browserLabel(browserInfo('curl/8.4.0')), 'Unknown');
  });

  test('the platform line carries the os and the window size', () => {
    assert.equal(platformLabel(browserInfo(UA.chromeMac), { width: 1024, height: 768 }), 'macOS · 1024×768');
  });

  test('a viewport that was never reported is left out, not shown as 0×0', () => {
    // What a recording made before the window reported its size looks like.
    assert.equal(platformLabel(browserInfo(UA.chromeMac), { width: 0, height: 0 }), 'macOS');
  });

  test('an unknown platform leaves only the size', () => {
    assert.equal(platformLabel(browserInfo('curl/8.4.0'), { width: 800, height: 600 }), '800×600');
    assert.equal(platformLabel(browserInfo('curl/8.4.0'), { width: 0, height: 0 }), '');
  });
});
