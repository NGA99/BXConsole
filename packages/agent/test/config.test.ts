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
  // Tolerant because one test below locks the name, which is the whole point
  // of it: a property the page made non-configurable cannot be taken back.
  try {
    delete (globalThis as any)[INJECT_GLOBAL];
  } catch {
    (globalThis as any)[INJECT_GLOBAL] = undefined;
  }
};
beforeEach(clear);
afterEach(clear);

const RELAY = 'http://relay.test:7331/agent.js';

describe('the defaults', () => {
  test('a snippet that says nothing is a run with everything on but hosting', () => {
    // Which is why the Agent tab's default snippet is a bare script tag: a
    // parameter should mean "this run is not the usual one". Hosting is the
    // exception — off by default, because it rewrites the page it debugs.
    page({ src: RELAY });
    const c = readConfig();
    assert.equal(c.name, null);
    assert.equal(c.captureBodies, true);
    assert.equal(c.adopt, true);
    assert.equal(c.collect, true);
    assert.equal(c.screen, 'record');
    assert.equal(c.frame, 'off');
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
  test('each switch is read from its data attribute', () => {
    // Everything off, and hosting — the one that is off by default — on.
    page({ src: RELAY, data: { name: 'checkout', bodies: '0', adopt: '0', collect: '0', screen: 'viewer', frame: 'host' } });
    const c = readConfig();
    assert.equal(c.name, 'checkout');
    assert.equal(c.captureBodies, false);
    assert.equal(c.adopt, false);
    assert.equal(c.collect, false);
    assert.equal(c.screen, 'viewer');
    assert.equal(c.frame, 'host');
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

  test('only the exact magic value flips the page-changing ones', () => {
    // Recording stops only on "viewer" and hosting starts only on "host"; a
    // guessed spelling leaves both at their default rather than silently
    // changing the page or dropping the DOM stream.
    for (const v of ['0', 'false', 'no', 'record', 'on', 'HOST', '']) {
      page({ src: RELAY, data: { screen: v, frame: v } });
      assert.equal(readConfig().screen, 'record', `screen=${v}`);
      assert.equal(readConfig().frame, 'off', `frame=${v}`);
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
    // One call, because reading it is what removes it: see the block at the
    // bottom of this file.
    const c = readConfig();
    assert.equal(c.serverUrl, `wss://relay.test${WS_PATH.agent}`);
    assert.equal(c.scriptSrc, 'https://relay.test/agent.js');
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
    let c: ReturnType<typeof readConfig> | undefined;
    assert.doesNotThrow(() => (c = readConfig()));
    assert.equal(c!.serverUrl, `ws://relay.test:7331${WS_PATH.agent}`, 'it falls back to the script it came from');
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

/**
 * The one name the mark cannot rename.
 *
 * Every other trace the agent leaves is built from `mark`, so it changes per
 * engagement; this one cannot be, because the mark arrives inside it. Leaving
 * it in the page would hand a defender the fixed grep that finds every host
 * this tool has touched regardless of what `data-mark` said — and of all the
 * traces it is the one that says where the data goes and what the run is
 * called. So it is read once and taken off the window.
 */
describe('the config global does not outlive the read', () => {
  test('reading it takes it off the window', () => {
    page({ injected: { origin: 'https://relay.test', name: 'checkout' } });
    const c = readConfig();
    assert.equal(c.name, 'checkout', 'it was read before it was removed');
    assert.ok(!(INJECT_GLOBAL in (globalThis as any)), 'and removed after');
  });

  test('not merely hidden from Object.keys — gone', () => {
    // The page would find it either way: a non-enumerable property still
    // answers to its name and still shows in getOwnPropertyNames.
    page({ injected: { origin: 'https://relay.test' } });
    readConfig();
    assert.ok(!Object.keys(globalThis as any).includes(INJECT_GLOBAL));
    assert.ok(!Object.getOwnPropertyNames(globalThis as any).includes(INJECT_GLOBAL));
    assert.equal((globalThis as any)[INJECT_GLOBAL], undefined);
  });

  test('a second read finds the injected half gone', () => {
    // Which is why boot calls this exactly once. Pinned so that a second
    // caller added later fails here rather than in a page, where it would
    // look like a relay that stopped answering.
    page({ injected: { origin: 'https://relay.test', name: 'checkout' } });
    assert.equal(readConfig().name, 'checkout');
    assert.equal(readConfig().name, null);
  });

  test('a page with no agent config at all is still read without complaint', () => {
    page({ src: RELAY });
    assert.doesNotThrow(() => readConfig());
    assert.ok(!(INJECT_GLOBAL in (globalThis as any)));
  });

  // Last in the file: a non-configurable property cannot be taken back off
  // globalThis, so this one leaves the name behind for the rest of the run.
  test('a name the page locked first does not stop the agent starting', () => {
    const planted = { origin: 'https://relay.test' };
    Object.defineProperty(globalThis, INJECT_GLOBAL, { value: planted, writable: true, configurable: false });
    (globalThis as any).document = { currentScript: null, querySelectorAll: () => [] };
    (globalThis as any).location = { href: 'https://app.test/x', protocol: 'https:', host: 'app.test' };
    let c: ReturnType<typeof readConfig> | undefined;
    assert.doesNotThrow(() => (c = readConfig()), 'the delete throws in a module, and is caught');
    assert.equal(c!.serverUrl, `wss://relay.test${WS_PATH.agent}`, 'the run goes on with what it could read');
  });
});

/**
 * The project key.
 *
 * The one option the agent does not act on: it carries it to the relay and
 * the relay turns it into a project. Reading it wrongly does not degrade the
 * run, it loses it — a hello with no key is refused, and the operator sees a
 * payload that fires and never appears.
 */
describe('the project key', () => {
  const KEY = 'a'.repeat(32);

  test('it is read from a script tag, from the injected config, and from the url', () => {
    page({ data: { key: KEY } });
    assert.equal(readConfig().key, KEY);
    clear();

    page({ src: 'https://relay.test/agent.js', injected: { key: KEY } });
    assert.equal(readConfig().key, KEY);
    clear();

    page({ src: `https://relay.test/agent.js?key=${KEY}` });
    assert.equal(readConfig().key, KEY);
  });

  test('a script tag wins over the injected config, which wins over the url', () => {
    page({
      src: `https://relay.test/agent.js?key=${'c'.repeat(32)}`,
      data: { key: 'a'.repeat(32) },
      injected: { key: 'b'.repeat(32) },
    });
    assert.equal(readConfig().key, 'a'.repeat(32));
    clear();

    page({ src: `https://relay.test/agent.js?key=${'c'.repeat(32)}`, injected: { key: 'b'.repeat(32) } });
    assert.equal(readConfig().key, 'b'.repeat(32));
  });

  test('a payload with no key reads as none, not as an empty one', () => {
    page({ src: 'https://relay.test/agent.js?name=run' });
    assert.equal(readConfig().key, null);
  });

  test('it is passed through untouched, whatever it looks like', () => {
    // The agent is not the one that judges a key; the relay is, and it
    // refuses what it does not know. Trimming or rejecting one here would
    // turn a wrong key into no key, and those get different answers.
    page({ data: { key: 'not-a-key' } });
    assert.equal(readConfig().key, 'not-a-key');
  });
});
