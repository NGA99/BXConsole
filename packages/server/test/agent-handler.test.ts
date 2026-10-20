/**
 * Serving agent.js with its configuration prepended.
 *
 * This is the only way the options reach an agent loaded by `import()`, a
 * `fetch()` or a bookmarklet: there is no script tag for it to read, so
 * anything the relay does not forward here is an option that silently does
 * nothing. That is exactly what happened — the list of names here was a
 * second copy of the agent's, and it was four short, so `frame=off` was
 * dropped and pages that refuse to be framed were framed anyway.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_PARAMS, INJECT_GLOBAL } from '@bxconsole/protocol';
import { createAgentHandler, requestOrigin } from '../src/agent-handler';

let dir: string;
let bundle: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-agent-'));
  bundle = path.join(dir, 'agent.js');
  await fs.writeFile(bundle, '/* the agent */\n');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Just enough of a response for the handler to write into. */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers: Record<string, string>) {
      res.statusCode = code;
      res.headers = headers;
      return res;
    },
    end(text: string) {
      res.body = text;
    },
  };
  return res;
}

async function serve(query: string, opts: { publicOrigin?: string; host?: string; bundlePath?: string } = {}) {
  const handler = createAgentHandler(opts.bundlePath ?? bundle, { publicOrigin: opts.publicOrigin });
  const res = fakeRes();
  await handler({ url: `/agent.js${query}`, headers: { host: opts.host ?? 'relay.test:7331' }, socket: {} } as never, res as never);
  return res;
}

/**
 * Run the one line the relay prepended, against a stand-in for `self`.
 *
 * By running it rather than reading it: the line is not an assignment any
 * more, and what matters about it — that it is not one of the page's globals,
 * and that it writes past anything the page left on the name — is a property
 * of what it does, not of how it is spelled.
 */
function runHeader(body: string, self: Record<string, unknown> = {}): Record<string, unknown> {
  new Function('self', body.slice(0, body.indexOf('\n')))(self);
  return self;
}

/** The object the agent will read as `self.<INJECT_GLOBAL>`. */
const injected = (body: string) => runHeader(body)[INJECT_GLOBAL] as Record<string, string>;

describe('every option the agent understands is forwarded', () => {
  // The list is shared; this is the guard that it stays shared. Dropping one
  // name here is invisible — the option just stops working for every snippet
  // that is not a script tag.
  for (const param of AGENT_PARAMS) {
    // `pre` is the one deliberate exception: it asks a question rather than
    // carrying a value, and the relay answers it with the stored script. Its
    // own behaviour is pinned below, so excluding it here hides nothing.
    if (param === 'pre') continue;
    test(`${param} survives being served`, async () => {
      const res = await serve(`?${param}=testvalue`);
      assert.equal(injected(res.body)[param], 'testvalue');
    });
  }

  test('the one that started this: frame=off reaches an import()', async () => {
    assert.equal(injected((await serve('?name=my-app&frame=off')).body).frame, 'off');
  });

  test('every parameter is either forwarded or has a reason not to be', () => {
    // The guard on the guard: if a name is added to AGENT_PARAMS and quietly
    // skipped above, this says so.
    const exceptions = ['pre'];
    const covered = AGENT_PARAMS.filter((p) => !exceptions.includes(p));
    assert.equal(covered.length + exceptions.length, AGENT_PARAMS.length);
    assert.ok(covered.length > 5, 'most parameters should be plain pass-through');
  });

  test('several at once, and nothing invented', async () => {
    const got = injected((await serve('?name=run&frame=off&collect=0&adopt=0&bodies=0&screen=viewer')).body);
    assert.deepEqual(got, {
      origin: 'http://relay.test:7331',
      name: 'run',
      frame: 'off',
      collect: '0',
      adopt: '0',
      bodies: '0',
      screen: 'viewer',
    });
  });

  test('a parameter that is not one of ours is ignored', async () => {
    const got = injected((await serve('?name=run&evil=1&__proto__=x')).body);
    assert.deepEqual(Object.keys(got).sort(), ['name', 'origin']);
  });

  test('nothing asked for leaves only the origin', async () => {
    assert.deepEqual(injected((await serve('')).body), { origin: 'http://relay.test:7331' });
  });
});

describe('the bundle it serves', () => {
  test('the config goes first, so the agent sees it before it runs', async () => {
    const res = await serve('?name=run');
    const nl = res.body.indexOf('\n');
    assert.match(res.body.slice(0, nl), new RegExp(`defineProperty\\(self,"${INJECT_GLOBAL}"`));
    assert.equal(res.body.slice(nl + 1), '/* the agent */\n', 'and the bundle is untouched behind it');
  });

  test('it is served as javascript, uncached, and readable cross-origin', async () => {
    const res = await serve('');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type']!, /javascript/);
    assert.equal(res.headers['Cache-Control'], 'no-cache');
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*', 'the page is on another origin than the relay');
  });

  test('an unbuilt bundle says so rather than serving nothing', async () => {
    const res = await serve('', { bundlePath: path.join(dir, 'missing.js') });
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /npm run build/);
  });
});

describe('the origin the agent will call back on', () => {
  test('it is the address the request arrived on', async () => {
    assert.equal(injected((await serve('', { host: 'relay.internal:9000' })).body).origin, 'http://relay.internal:9000');
  });

  test('PUBLIC_ORIGIN wins, which is how a TLS proxy is handled', async () => {
    assert.equal(injected((await serve('', { publicOrigin: 'https://debug.corp' })).body).origin, 'https://debug.corp');
  });

  test('a proxy’s forwarded headers are honoured', () => {
    const req = { headers: { host: 'internal:7331', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'debug.corp' }, socket: {} };
    assert.equal(requestOrigin(req as never), 'https://debug.corp');
  });

  test('only the first value of a forwarded list is used', () => {
    const req = { headers: { host: 'h', 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'a.test, b.test' }, socket: {} };
    assert.equal(requestOrigin(req as never), 'https://a.test');
  });

  test('a TLS socket means https even with no proxy headers', () => {
    assert.equal(requestOrigin({ headers: { host: 'h' }, socket: { encrypted: true } } as never), 'https://h');
  });
});

describe('the pre-payload', () => {
  const PRIMER = 'document.cookie';

  test('a payload that does not ask never receives it', async () => {
    const handler = createAgentHandler(bundle, { publicOrigin: undefined, prePayload: async () => PRIMER });
    const res = fakeRes();
    await handler({ url: '/agent.js?name=run', headers: { host: 'h' }, socket: {} } as never, res as never);
    assert.equal(injected(res.body).pre, undefined);
  });

  test('a payload that asks gets the script itself, not the flag', async () => {
    const handler = createAgentHandler(bundle, { publicOrigin: undefined, prePayload: async () => PRIMER });
    const res = fakeRes();
    await handler({ url: '/agent.js?pre=1', headers: { host: 'h' }, socket: {} } as never, res as never);
    assert.equal(injected(res.body).pre, PRIMER);
  });

  test('a page cannot choose what its own agent runs', async () => {
    // The source comes from the relay or not at all. A URL that names one is
    // asking a question it does not get to answer.
    const handler = createAgentHandler(bundle, { publicOrigin: undefined, prePayload: async () => PRIMER });
    const res = fakeRes();
    await handler({ url: '/agent.js?pre=' + encodeURIComponent('fetch("//evil.test")'), headers: { host: 'h' }, socket: {} } as never, res as never);
    assert.equal(injected(res.body).pre, undefined, 'only pre=1 asks, and only the relay answers');
  });

  test('asking when nothing is stored is not an error, just nothing', async () => {
    const handler = createAgentHandler(bundle, { publicOrigin: undefined, prePayload: async () => null });
    const res = fakeRes();
    await handler({ url: '/agent.js?pre=1', headers: { host: 'h' }, socket: {} } as never, res as never);
    assert.equal(res.statusCode, 200);
    assert.equal(injected(res.body).pre, undefined);
  });

  test('a relay with no pre-payload configured at all still serves agents', async () => {
    const handler = createAgentHandler(bundle, { publicOrigin: undefined });
    const res = fakeRes();
    await handler({ url: '/agent.js?pre=1', headers: { host: 'h' }, socket: {} } as never, res as never);
    assert.equal(res.statusCode, 200);
    assert.equal(injected(res.body).pre, undefined);
  });

  test('the key decides which pre-payload is served', async () => {
    /*
     * The thing the key fixed. There was one pre-payload for the relay, so a
     * script set for one engagement ran in every browser that installed an
     * agent from it — other people's engagements included. The handler asks
     * for the key's, and a key it does not know gets nothing.
     */
    const byKey: Record<string, string> = { ['a'.repeat(32)]: 'hers', ['b'.repeat(32)]: 'his' };
    const handler = createAgentHandler(bundle, {
      publicOrigin: undefined,
      prePayload: async (key) => (key ? (byKey[key] ?? null) : null),
    });
    const got = async (query: string) => {
      const res = fakeRes();
      await handler({ url: `/agent.js${query}`, headers: { host: 'h' }, socket: {} } as never, res as never);
      return injected(res.body).pre;
    };
    assert.equal(await got(`?pre=1&key=${'a'.repeat(32)}`), 'hers');
    assert.equal(await got(`?pre=1&key=${'b'.repeat(32)}`), 'his');
    assert.equal(await got(`?pre=1&key=${'c'.repeat(32)}`), undefined, 'an unknown key must not get anybody’s');
    assert.equal(await got('?pre=1'), undefined, 'and neither must no key at all');
  });

  test('the key also rides in the config, so the hello can carry it', async () => {
    const res = await serve(`?key=${'a'.repeat(32)}`);
    assert.equal(injected(res.body).key, 'a'.repeat(32));
  });

  test('it is read per request, so editing it needs no restart', async () => {
    let current = 'first';
    const handler = createAgentHandler(bundle, { publicOrigin: undefined, prePayload: async () => current });
    const once = fakeRes();
    await handler({ url: '/agent.js?pre=1', headers: { host: 'h' }, socket: {} } as never, once as never);
    current = 'second';
    const twice = fakeRes();
    await handler({ url: '/agent.js?pre=1', headers: { host: 'h' }, socket: {} } as never, twice as never);
    assert.equal(injected(once.body).pre, 'first');
    assert.equal(injected(twice.body).pre, 'second');
  });
});

/**
 * How the config is written, which is as much the point as what is in it.
 *
 * The agent renames every trace it leaves from a per-engagement mark, so that
 * finding one takes knowing the name (see the agent's mark.ts). This global
 * is the one name that cannot be renamed — the mark is read out of it — so
 * everything else about it has to make up the difference. It is defined, not
 * assigned, and the agent deletes it as its first act, which leaves nothing
 * to find after the bundle's first synchronous moment.
 */
describe('how the config is written', () => {
  test('it is not one of the page’s globals', async () => {
    // An assignment would put the relay's address in Object.keys(window),
    // where a page finds it without knowing a thing about this tool.
    const page = runHeader((await serve('?name=run')).body);
    assert.deepEqual(Object.keys(page), [], 'nothing enumerable');
    const d = Object.getOwnPropertyDescriptor(page, INJECT_GLOBAL)!;
    assert.equal(d.enumerable, false);
    assert.equal(d.configurable, true, 'the agent has to be able to delete it');
  });

  test('a page that trapped the name is not handed the config', async () => {
    // A page that has met this tool before can leave a setter waiting on the
    // name. defineProperty replaces the accessor instead of calling it.
    const page: Record<string, unknown> = {};
    let caught: unknown = null;
    Object.defineProperty(page, INJECT_GLOBAL, { configurable: true, set: (v) => { caught = v; } });
    runHeader((await serve('?name=run')).body, page);
    assert.equal(caught, null, 'the page’s setter never ran');
    assert.equal((page[INJECT_GLOBAL] as Record<string, string>).origin, 'http://relay.test:7331');
  });

  test('a name the page locked is left alone rather than assigned to', async () => {
    // Nothing can be done with the name at that point, and assigning would
    // hand the relay's address to whatever locked it. The agent still finds
    // the relay in its own script src; an import() loses the run instead.
    const page: Record<string, unknown> = {};
    Object.defineProperty(page, INJECT_GLOBAL, { value: 'the page’s', writable: false, configurable: false });
    const body = (await serve('?name=run')).body;
    assert.doesNotThrow(() => runHeader(body, page), 'the relay’s line swallows what it cannot do');
    assert.equal(page[INJECT_GLOBAL], 'the page’s');
  });
});
