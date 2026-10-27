/**
 * The Agent tab hands someone a line to paste into a page they cannot reload
 * twice. If the options they ticked are not in that line, the run comes back
 * missing whatever they asked for and nothing says why — so what is pinned
 * here is that every form of the snippet carries the same choices.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PARAMS } from '@bxconsole/protocol';
import { DEFAULTS, SETUP_KEY, attrsFor, loadSetup, paramsFor, queryFor, saveSetup, snippetsFor, type Setup } from '../src/panels/sessions/agent-setup';

const ORIGIN = 'http://relay.test:7331';
const setup = (over: Partial<Setup> = {}): Setup => ({ ...DEFAULTS, ...over });

/** localStorage, as much of it as this module touches. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

/**
 * What the agent itself assumes when a snippet says nothing: everything on,
 * the same as the tab. So a run with nothing turned off needs no parameters,
 * and the snippet is a bare script tag.
 */
const AGENT_DEFAULTS: Omit<Setup, 'name'> = { record: true, bodies: true, adopt: true, frame: false, collect: true, pre: false, key: '' };
const asAgent = (over: Partial<Setup> = {}): Setup => ({ name: 'my-app', ...AGENT_DEFAULTS, ...over });
/** A project key is 16 bytes of hex; the value does not matter here, the shape does. */
const KEY = 'a'.repeat(32);

describe('the choices', () => {
  test('the tab starts where the agent already is, so nothing needs saying', () => {
    assert.deepEqual({ ...DEFAULTS, name: 'x' }, { ...asAgent(), name: 'x' });
    assert.deepEqual(paramsFor(DEFAULTS), [['name', 'my-app']]);
  });

  test('a snippet at the defaults is a bare script tag', () => {
    const [script] = snippetsFor(DEFAULTS, ORIGIN);
    assert.equal(script!.code, `<script src="${ORIGIN}/agent.js" data-name="my-app"></script>`);
    assert.equal(snippetsFor({ ...DEFAULTS, name: '' }, ORIGIN)[0]!.code, `<script src="${ORIGIN}/agent.js"></script>`);
  });

  test('only the switches that are off are spelled out', () => {
    // A parameter should mean "this run is not the usual one", so reading a
    // snippet tells you what the person chose rather than restating defaults.
    assert.deepEqual(paramsFor(asAgent({ record: false, bodies: false, adopt: false, collect: false })), [
      ['name', 'my-app'],
      ['screen', 'viewer'],
      ['bodies', '0'],
      ['adopt', '0'],
      ['collect', '0'],
    ]);
  });

  test('one switch changed names that one and no others', () => {
    assert.deepEqual(paramsFor(asAgent({ bodies: false })), [['name', 'my-app'], ['bodies', '0']]);
    // Nest is off by default, so it is the one that names itself when turned on.
    assert.deepEqual(paramsFor(asAgent({ frame: true })), [['name', 'my-app'], ['frame', 'host']]);
  });

  test('an empty name is left out rather than sent as empty', () => {
    assert.deepEqual(paramsFor(asAgent({ name: '   ' })), []);
    assert.equal(queryFor(asAgent({ name: '' })), '');
  });

  test('a name is trimmed, escaped as an attribute and encoded in a query', () => {
    const odd = asAgent({ name: '  a&b "c" <d>  ' });
    assert.equal(attrsFor(odd), ' data-name="a&amp;b &quot;c&quot; &lt;d&gt;"');
    assert.equal(queryFor(odd), '?name=a%26b%20%22c%22%20%3Cd%3E');
  });
});

describe('the snippets', () => {
  test('every form carries the same choices', () => {
    const chosen = asAgent({ name: 'checkout', record: false, frame: true });
    for (const s of snippetsFor(chosen, ORIGIN)) {
      assert.match(s.code, /checkout/, `${s.id} lost the name`);
      assert.match(s.code, /viewer/, `${s.id} lost the screen option`);
      assert.match(s.code, /host/, `${s.id} lost the frame option`);
      assert.match(s.code, new RegExp(ORIGIN.replace(/[.:/]/g, '\\$&')), `${s.id} lost the relay`);
    }
  });

  test('the script tag uses attributes, the rest use a query', () => {
    const byId = new Map(snippetsFor(asAgent({ record: false }), ORIGIN).map((s) => [s.id, s.code]));
    assert.match(byId.get('script')!, /data-screen="viewer"/);
    assert.ok(!byId.get('script')!.includes('agent.js?'), 'the script tag should not carry both');
    for (const id of ['img', 'import', 'fetch', 'bookmarklet']) {
      assert.match(byId.get(id)!, /agent\.js\?/, `${id} should carry a query`);
    }
  });

  test('a name with an apostrophe does not end the string it sits in', () => {
    /*
     * encodeURIComponent leaves ' alone, which is right for a URL and wrong
     * for three of these: img, bookmarklet and the fetch form all put the
     * address in single quotes. A run called "client's site" produced a
     * payload that was a syntax error — copied, pasted, and silently doing
     * nothing on a tool that usually gets one attempt.
     */
    const byId = new Map(snippetsFor(asAgent({ name: "client's site" }), ORIGIN).map((s) => [s.id, s.code]));
    assert.equal(queryFor(asAgent({ name: "client's site" })), '?name=client%27s%20site');
    // No form may carry the apostrophe raw: each one quotes the address.
    for (const id of ['img', 'import', 'fetch', 'bookmarklet']) {
      assert.ok(!byId.get(id)!.includes("client's"), `${id} still carries a bare apostrophe`);
    }
    // The handler has to survive being parsed as an attribute and then as JS.
    const onerror = /onerror="([^"]*)"/.exec(byId.get('img')!)![1]!;
    assert.doesNotThrow(() => new Function(onerror), 'the img handler is not valid JavaScript');
    assert.doesNotThrow(() => new Function(byId.get('bookmarklet')!.replace(/^javascript:/, '')), 'the bookmarklet is not valid JavaScript');
    // And the name must still arrive intact at the other end.
    assert.equal(new URL(`${ORIGIN}/agent.js${queryFor(asAgent({ name: "client's site" }))}`).searchParams.get('name'), "client's site");
  });

  test('parentheses in a name do not close a bookmarklet early', () => {
    const name = 'acme (staging)';
    const byId = new Map(snippetsFor(asAgent({ name }), ORIGIN).map((s) => [s.id, s.code]));
    assert.doesNotThrow(() => new Function(byId.get('bookmarklet')!.replace(/^javascript:/, '')));
    assert.equal(new URL(`${ORIGIN}/agent.js${queryFor(asAgent({ name }))}`).searchParams.get('name'), name);
  });

  test('a tagless form is still a single pasteable expression', () => {
    const byId = new Map(snippetsFor(asAgent(), ORIGIN).map((s) => [s.id, s.code]));
    assert.ok(!byId.get('bookmarklet')!.includes('\n'));
    assert.match(byId.get('bookmarklet')!, /^javascript:/);
    // The inline handler sits inside a double-quoted attribute, so the script
    // it builds must not use double quotes itself.
    const onerror = /onerror="([^"]*)"/.exec(byId.get('img')!);
    assert.ok(onerror, 'the img form should have a readable inline handler');
    assert.ok(!onerror![1]!.includes('"'), 'the handler would end its own attribute');
  });
});

describe('remembering the setup', () => {
  test('a round trip survives', () => {
    const store = fakeStorage();
    const chosen = setup({ name: 'checkout', record: true, bodies: false });
    saveSetup(chosen, store);
    assert.deepEqual(loadSetup(store), chosen);
  });

  test('an option saved before it existed falls back to its default, not to off', () => {
    // `adopt` defaults to on; a setup stored before it was added has no such
    // key, and reading it as absent-means-false would quietly turn it off.
    const store = fakeStorage({ [SETUP_KEY]: JSON.stringify({ name: 'old', record: true }) });
    const loaded = loadSetup(store);
    assert.equal(loaded.adopt, true);
    assert.equal(loaded.bodies, true);
    assert.equal(loaded.record, true);
    assert.equal(loaded.name, 'old');
  });

  test('a corrupt or empty entry reads as the defaults', () => {
    assert.deepEqual(loadSetup(fakeStorage({ [SETUP_KEY]: 'not json' })), DEFAULTS);
    assert.deepEqual(loadSetup(fakeStorage()), DEFAULTS);
  });

  test('storage that throws does not take the tab down with it', () => {
    const angry = {
      getItem: () => {
        throw new Error('private window');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    assert.deepEqual(loadSetup(angry), DEFAULTS);
    assert.doesNotThrow(() => saveSetup(setup(), angry));
  });
});

describe('every parameter a snippet can emit is one the agent reads', () => {
  test('nothing the tab writes is dropped on the way', () => {
    // The gap that let the frame option be ignored: the console wrote a name
    // the relay did not forward, and the only symptom was an option that
    // quietly did nothing in every snippet except the script tag. Every switch
    // at its non-default — frame on, the rest off — so each one has to travel.
    const nonDefault: Setup = { name: 'n', record: false, bodies: false, adopt: false, frame: true, collect: false, pre: false, key: '' };
    for (const [key] of paramsFor(nonDefault)) {
      assert.ok((AGENT_PARAMS as readonly string[]).includes(key), `the agent does not read "${key}"`);
    }
  });

  test('and every switch is represented, so none is unreachable', () => {
    const nonDefault: Setup = { name: 'n', record: false, bodies: false, adopt: false, frame: true, collect: false, pre: false, key: '' };
    const written = paramsFor(nonDefault).map(([k]) => k);
    assert.deepEqual(written.sort(), ['adopt', 'bodies', 'collect', 'frame', 'name', 'screen']);
  });
});

/**
 * The project key in the snippet.
 *
 * Unlike every other parameter here, this one is not an option: it decides
 * whether the run is recorded at all. A payload with no key is refused, and
 * refused in the worst place to find out — a browser nobody can reach, with
 * nothing to look at afterwards. So a snippet without it is a snippet that
 * silently does nothing.
 */
describe('the project key', () => {
  test('it leads the parameters, ahead of the options', () => {
    assert.deepEqual(paramsFor(asAgent({ key: KEY })), [['key', KEY], ['name', 'my-app']]);
  });

  test('every snippet carries it, because every one of them installs an agent', () => {
    const snippets = snippetsFor(asAgent({ key: KEY }), ORIGIN);
    for (const s of snippets) assert.ok(s.code.includes(KEY), `${s.id} has no key: ${s.code}`);
  });

  test('a script tag carries it as data-key, not in the url', () => {
    // A URL ends up in access logs and in Referer headers on the way out of
    // the page; a data attribute does not.
    const [script] = snippetsFor(asAgent({ key: KEY }), ORIGIN);
    assert.equal(script!.code, `<script src="${ORIGIN}/agent.js" data-key="${KEY}" data-name="my-app"></script>`);
  });

  test('asking for the pre-payload moves it to the url, and only once', () => {
    /*
     * The relay has to read the key off the request to know whose
     * pre-payload to send — it never sees a data attribute. So when `pre` is
     * asked for the key goes on the src, and the attribute is dropped rather
     * than written twice into something a person pastes by hand.
     */
    const [script] = snippetsFor(asAgent({ key: KEY, pre: true }), ORIGIN);
    assert.equal(script!.code, `<script src="${ORIGIN}/agent.js?pre=1&key=${KEY}" data-name="my-app"></script>`);
    assert.equal(script!.code.match(new RegExp(KEY, 'g'))?.length, 1);
  });

  test('no key means no key in the snippet, not an empty one', () => {
    const [script] = snippetsFor(asAgent({ key: '' }), ORIGIN);
    assert.equal(script!.code, `<script src="${ORIGIN}/agent.js" data-name="my-app"></script>`);
    assert.deepEqual(paramsFor(asAgent({ key: '' })), [['name', 'my-app']]);
  });

  test('it is never saved, and never read back from storage', () => {
    /*
     * A key can be rotated. A copy kept in the browser would go on being
     * pasted into pages long after the relay stopped honouring it — a
     * snippet that reads correctly and records nothing.
     */
    const held: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => held[k] ?? null,
      setItem: (k: string, v: string) => void (held[k] = v),
    };
    saveSetup(asAgent({ key: KEY, name: 'kept' }), storage);
    assert.ok(!JSON.stringify(held).includes(KEY), `the key was written: ${JSON.stringify(held)}`);
    assert.equal(loadSetup(storage).name, 'kept', 'the rest of the setup still is');
    assert.equal(loadSetup(storage).key, '');

    // And an older build that did write one is not trusted either.
    held[SETUP_KEY] = JSON.stringify({ ...asAgent({ key: KEY }), name: 'kept' });
    assert.equal(loadSetup(storage).key, '');
  });
});
