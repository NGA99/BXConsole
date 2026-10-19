/**
 * The URL one window hands the next.
 *
 * A run that spans several windows is configured once, in the snippet pasted
 * into the first one. Every window after that is given a URL this builds, so
 * anything missing from it is a choice silently dropped — the second window
 * joins the same session and quietly stops recording, or stops capturing
 * bodies, and the recording reads as if the page misbehaved.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../src/config';
import { agentUrl } from '../src/agent-url';

const BASE = 'https://app.test/checkout';

/** What the agent assumes when a URL says nothing: everything on. */
const DEFAULTS: AgentConfig = {
  name: null,
  scriptSrc: 'http://relay.test:7331/agent.js',
  serverUrl: 'ws://relay.test:7331/ws/agent',
  captureBodies: true,
  maxBodyLength: 65536,
  screen: 'record',
  sessionId: null,
  tabId: null,
  adopt: true,
  frame: 'host',
  collect: true,
};
const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({ ...DEFAULTS, ...over });
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('what always travels', () => {
  test('the session is named, so the next window joins instead of starting its own', () => {
    assert.equal(params(agentUrl(config(), 'sess1', BASE)).session, 'sess1');
  });

  test('the window id does not travel: the next window is not this one', () => {
    const withTab = config({ scriptSrc: 'http://relay.test:7331/agent.js?tab=t9&session=old' });
    const got = params(agentUrl(withTab, 'sess1', BASE));
    assert.equal(got.tab, undefined);
    assert.equal(got.session, 'sess1', 'the stale session should be replaced, not kept');
  });

  test('hosting travels as the default, so a stale flag is cleared rather than repeated', () => {
    const hosted = config({ frame: 'host', scriptSrc: 'http://relay.test:7331/agent.js?frame=off' });
    assert.equal(params(agentUrl(hosted, 'sess1', BASE)).frame, undefined, 'on is the default and needs no parameter');
  });

  test('a run with hosting turned off says so, or the next window turns it back on', () => {
    assert.equal(params(agentUrl(config({ frame: 'off' }), 'sess1', BASE)).frame, 'off');
  });

  test('a relative script src resolves against the page, not against nothing', () => {
    const rel = config({ scriptSrc: null });
    assert.equal(new URL(agentUrl(rel, 'sess1', BASE)).origin, 'https://app.test');
  });
});

describe('the run’s choices reach the next window', () => {
  test('recording from boot is the default, and turning it off travels', () => {
    assert.equal(params(agentUrl(config(), 's', BASE)).screen, undefined);
    assert.equal(params(agentUrl(config({ screen: 'viewer' }), 's', BASE)).screen, 'viewer');
  });

  test('bodies turned off', () => {
    assert.equal(params(agentUrl(config({ captureBodies: false }), 's', BASE)).bodies, '0');
    assert.equal(params(agentUrl(config(), 's', BASE)).bodies, undefined);
  });

  test('collection turned off', () => {
    assert.equal(params(agentUrl(config({ collect: false }), 's', BASE)).collect, '0');
    assert.equal(params(agentUrl(config(), 's', BASE)).collect, undefined);
  });

  test('a named run keeps its name', () => {
    assert.equal(params(agentUrl(config({ name: 'checkout flow' }), 's', BASE)).name, 'checkout flow');
  });

  test('every switch turned off at once, and nothing else', () => {
    const url = agentUrl(config({ name: 'n', screen: 'viewer', captureBodies: false, collect: false, adopt: false, frame: 'off' }), 'sess1', BASE);
    assert.deepEqual(params(url), { session: 'sess1', name: 'n', screen: 'viewer', bodies: '0', collect: '0', adopt: '0', frame: 'off' });
  });

  test('a run with nothing turned off carries only the session', () => {
    assert.deepEqual(params(agentUrl(config(), 'sess1', BASE)), { session: 'sess1' });
  });

  test('a default choice clears a stale parameter rather than passing it on', () => {
    // The script that loaded this window said bodies=0; this window's config
    // says otherwise, and the config is what the run actually is.
    const stale = config({ scriptSrc: 'http://relay.test:7331/agent.js?bodies=0&screen=viewer&collect=0&frame=off' });
    assert.deepEqual(params(agentUrl(stale, 's', BASE)), { session: 's' });
  });
});

describe('when it cannot build a URL', () => {
  test('a src that is not a URL comes back untouched rather than throwing', () => {
    const bad = config({ scriptSrc: 'http://[not a url/agent.js' });
    assert.equal(agentUrl(bad, 's', 'also not a url'), 'http://[not a url/agent.js');
  });

  test('no src at all still produces something loadable', () => {
    assert.equal(agentUrl(config({ scriptSrc: null }), 's', BASE), 'https://app.test/agent.js?session=s');
  });
});
