/**
 * Reading the agent's configuration out of the page it landed in.
 *
 * This is the one line someone pasted into a page they cannot easily reload,
 * so every option it drops is a run that comes back missing something, with
 * nothing to say why. The precedence matters as much as the parsing: a script
 * tag's `data-*` wins over what the relay injected, which wins over the query
 * on the script's own URL.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { INJECT_GLOBAL, WS_PATH } from '@bxconsole/protocol';
import { readConfig } from '../src/config';

/** Enough of a document for readConfig: one script tag and a location. */
function page(opts: { src?: string; data?: Record<string, string>; injected?: Record<string, string>; href?: string } = {}) {
  const dataset = { ...(opts.data ?? {}) };
  const script = opts.src === undefined && !Object.keys(dataset).length ? null : { src: opts.src ?? '', dataset };
  (globalThis as any).document = {
    currentScript: script,
    querySelectorAll: () => (script && script.src ? [script] : []),
  };
  (globalThis as any).location = { href: opts.href ?? 'https://app.test/checkout', protocol: 'https:', host: 'app.test' };
  (globalThis as any)[INJECT_GLOBAL] = opts.injected;
}

const clear = () => {
  delete (globalThis as any).document;
  delete (globalThis as any).location;
  delete (globalThis as any)[INJECT_GLOBAL];
};
beforeEach(clear);
afterEach(clear);

const RELAY = 'http://relay.test:7331/agent.js';

describe('the defaults', () => {
  test('a snippet that says nothing is a run with everything on', () => {
    // Which is why the Agent tab's default snippet is a bare script tag: a
    // parameter should mean "this run is not the usual one".
    page({ src: RELAY });
    const c = readConfig();
    assert.equal(c.name, null);
    assert.equal(c.captureBodies, true);
    assert.equal(c.adopt, true);
    assert.equal(c.collect, true);
    assert.equal(c.screen, 'record');
    assert.equal(c.frame, 'host');
  });

  test('the relay address is derived from where the script came from', () => {
    page({ src: RELAY });
    assert.equal(readConfig().serverUrl, `ws://relay.test:7331${WS_PATH.agent}`);
  });

  test('an https relay gets a wss socket, or the browser refuses it', () => {
    page({ src: 'https://relay.test/agent.js' });
    assert.equal(readConfig().serverUrl, `wss://relay.test${WS_PATH.agent}`);
  });

  test('with no script tag at all it falls back to the page’s own origin', () => {
    page({});
    assert.equal(readConfig().serverUrl, `wss://app.test${WS_PATH.agent}`);
  });
});

describe('data-* on the script tag', () => {
  test('each switch can be turned off', () => {
    page({ src: RELAY, data: { name: 'checkout', bodies: '0', adopt: '0', collect: '0', screen: 'viewer', frame: 'off' } });
    const c = readConfig();
    assert.equal(c.name, 'checkout');
    assert.equal(c.captureBodies, false);
    assert.equal(c.adopt, false);
    assert.equal(c.collect, false);
    assert.equal(c.screen, 'viewer');
    assert.equal(c.frame, 'off');
  });

  test('only the exact off value turns something off', () => {
    // "false", "no" and "" are not "0"; treating them as off would silently
    // disable capture for anyone who guessed the spelling.
    for (const v of ['false', 'no', '', '1', 'off']) {
      page({ src: RELAY, data: { bodies: v, adopt: v, collect: v } });
      const c = readConfig();
      assert.equal(c.captureBodies, true, `bodies=${v}`);
      assert.equal(c.adopt, true, `adopt=${v}`);
      assert.equal(c.collect, true, `collect=${v}`);
    }
  });

  test('only the exact off value turns the costly ones off', () => {
    for (const v of ['0', 'false', 'no', 'record', 'host', '']) {
      page({ src: RELAY, data: { screen: v, frame: v } });
      assert.equal(readConfig().screen, 'record', `screen=${v}`);
      assert.equal(readConfig().frame, 'host', `frame=${v}`);
    }
  });
});

describe('the query on the script’s own url', () => {
  test('options travel in it, which is how import() and a bookmarklet carry them', () => {
    page({ src: `${RELAY}?collect=0&adopt=0&screen=viewer&frame=off&session=sess1&tab=t9` });
    const c = readConfig();
    assert.equal(c.collect, false);
    assert.equal(c.adopt, false);
    assert.equal(c.screen, 'viewer');
    assert.equal(c.frame, 'off');
    assert.equal(c.sessionId, 'sess1');
    assert.equal(c.tabId, 't9');
  });

  test('a session and window named there are how an adopted window joins the run', () => {
    page({ src: `${RELAY}?session=abc&tab=t1` });
    assert.equal(readConfig().sessionId, 'abc');
    assert.equal(readConfig().tabId, 't1');
  });

  test('absent means not named, not empty', () => {
    page({ src: RELAY });
    assert.equal(readConfig().sessionId, null);
    assert.equal(readConfig().tabId, null);
  });
});

describe('what the relay injected when it served agent.js', () => {
  test('it supplies the relay address where there is no script tag to read', () => {
    page({ injected: { origin: 'https://relay.test' } });
    assert.equal(readConfig().serverUrl, `wss://relay.test${WS_PATH.agent}`);
    assert.equal(readConfig().scriptSrc, 'https://relay.test/agent.js');
  });

  test('it carries the options too', () => {
    page({ injected: { origin: 'http://relay.test:7331', name: 'from-relay', bodies: '0', collect: '0', screen: 'viewer', frame: 'off' } });
    const c = readConfig();
    assert.equal(c.name, 'from-relay');
    assert.equal(c.captureBodies, false);
    assert.equal(c.collect, false);
    assert.equal(c.screen, 'viewer');
    assert.equal(c.frame, 'off');
  });
});

describe('precedence', () => {
  test('the script tag wins over what the relay injected', () => {
    page({ src: RELAY, data: { name: 'from-tag', collect: '0' }, injected: { origin: 'https://relay.test', name: 'from-relay', collect: '1' } });
    const c = readConfig();
    assert.equal(c.name, 'from-tag');
    assert.equal(c.collect, false);
  });

  test('what the relay injected wins over the query on the url', () => {
    page({ src: `${RELAY}?collect=0`, injected: { origin: 'http://relay.test:7331', collect: '1' } });
    assert.equal(readConfig().collect, true);
  });

  test('an explicit data-server beats everything that was only inferred', () => {
    page({ src: RELAY, data: { server: 'wss://elsewhere.test/agent' }, injected: { origin: 'https://relay.test' } });
    assert.equal(readConfig().serverUrl, 'wss://elsewhere.test/agent');
  });
});

describe('malformed input', () => {
  test('an unparseable injected origin does not stop the agent starting', () => {
    page({ src: RELAY, injected: { origin: 'http://[not a url' } });
    assert.doesNotThrow(() => readConfig());
    assert.equal(readConfig().serverUrl, `ws://relay.test:7331${WS_PATH.agent}`, 'it falls back to the script it came from');
  });

  test('an unparseable script src does not stop it either', () => {
    // A browser resolves `src` before the agent reads it, so this cannot
    // happen in Chrome. It is pinned because the failure mode if it ever did
    // would be the worst available: readConfig throws, nothing is installed,
    // and the page is indistinguishable from one with no agent in it.
    page({ src: 'http://[broken', href: 'https://app.test/x' });
    assert.doesNotThrow(() => readConfig());
    assert.equal(readConfig().serverUrl, `wss://app.test${WS_PATH.agent}`, 'it falls back to the page it is in');
  });
});
