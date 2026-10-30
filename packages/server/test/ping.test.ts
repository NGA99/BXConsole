/**
 * The probe board: tokens, the bounded record of arrivals, and parsing the
 * probe URLs. Everything here is memory-only on purpose — the relay has no
 * login, and these records carry a client IP and a page URL.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PING_PER_TOKEN, PING_TOKEN_TTL_MS, PROBES } from '@bxconsole/protocol';
import { PingBoard, describeRequest, parseProbePath, scriptProbeBody } from '../src/ping';

/** Account ids: a token belongs to the account that asked for it. */
const ANA = 'a1a1a1';
const BO = 'b2b2b2';

describe('tokens', () => {
  test('a fresh token is known, a made-up one is not', () => {
    const board = new PingBoard();
    const { token } = board.issue(ANA);
    assert.ok(board.knows(token));
    assert.ok(!board.knows('neverissued'));
  });

  test('two runs do not collide', () => {
    const board = new PingBoard();
    const tokens = new Set(Array.from({ length: 50 }, () => board.issue(ANA).token));
    assert.equal(tokens.size, 50);
    for (const t of tokens) assert.match(t, /^[A-Za-z0-9]{6,32}$/, 'must survive the URL and the validator');
  });

  test('a token lasts the week it is documented to last', () => {
    // Pinned, because the number is a judgement about how the tab is used —
    // a URL pasted into a report form or a ticket is opened days later, not
    // in the same sitting — and a quiet drift back to a day would break that
    // in the one way nobody sees: the probe still answers 200.
    const board = new PingBoard();
    const { expiresAt } = board.issue(ANA);
    assert.equal(PING_TOKEN_TTL_MS, 7 * 24 * 60 * 60_000);
    assert.ok(Math.abs(expiresAt - Date.now() - PING_TOKEN_TTL_MS) < 1000);
  });

  test('an expiry in the past is not known', () => {
    const board = new PingBoard();
    const { token, expiresAt } = board.issue(ANA);
    assert.ok(expiresAt > Date.now());
    // Reach in rather than wait half an hour.
    (board as unknown as { tokens: Map<string, { until: number; owner: string }> }).tokens.set(token, { until: Date.now() - 1, owner: ANA });
    assert.ok(!board.knows(token));
  });
});

describe('arrivals', () => {
  test('are reported to listeners and readable afterwards', () => {
    const board = new PingBoard();
    const { token } = board.issue(ANA);
    const seen: string[] = [];
    board.onArrival((a) => seen.push(a.probe));
    board.record({ id: 'a1', token, probe: 'img', ts: 1 });
    board.record({ id: 'a2', token, probe: 'script', ts: 2 });
    assert.deepEqual(seen, ['img', 'script']);
    assert.deepEqual(board.since(token, ANA).map((a) => a.probe), ['img', 'script']);
  });

  test('one token cannot push out another', () => {
    const board = new PingBoard();
    const a = board.issue(ANA).token;
    const b = board.issue(ANA).token;
    board.record({ id: 'b0', token: b, probe: 'img', ts: 0 });
    for (let i = 0; i < PING_PER_TOKEN * 3; i++) board.record({ id: `a${i}`, token: a, probe: 'img', ts: i });
    assert.equal(board.since(a, ANA).length, PING_PER_TOKEN, 'the noisy one is trimmed');
    assert.equal(board.since(b, ANA).length, 1, 'the quiet one is kept');
  });

  test('a token nobody asked about reads as empty', () => {
    assert.deepEqual(new PingBoard().since('nothing', ANA), []);
  });

  /*
   * Whose probes these are.
   *
   * An arrival holds the client IP and the URL of the page the probe fired
   * on. The board used to be asked only for a token, and tokens are handed
   * to whoever asks — so any signed-in account could subscribe to any token
   * and read someone else's. The board remembers who it handed each one to.
   */
  test('only the account that asked for a token can read its arrivals', () => {
    const board = new PingBoard();
    const { token } = board.issue(ANA);
    board.record({ id: 'a1', token, probe: 'img', ts: 1 });

    assert.equal(board.since(token, ANA).length, 1);
    assert.deepEqual(board.since(token, BO), [], 'bo read ana’s probes');
    assert.deepEqual(board.since(token, undefined), [], 'a socket with no account read them');
    assert.equal(board.isOwnedBy(token, ANA), true);
    assert.equal(board.isOwnedBy(token, BO), false);
    assert.equal(board.isOwnedBy(token, undefined), false);
  });

  test('a probe still arrives for a token whoever fires it, because nobody is at the keyboard', () => {
    // `knows` is what the probe routes ask, and they are reached by a
    // victim's browser. It says whether to record, not who may read.
    const board = new PingBoard();
    const { token } = board.issue(ANA);
    assert.equal(board.knows(token), true);
    board.record({ id: 'a1', token, probe: 'img', ts: 1 });
    assert.equal(board.since(token, ANA).length, 1);
  });

  test('a token that has lapsed is nobody’s, not its owner’s', () => {
    const board = new PingBoard();
    const { token } = board.issue(ANA);
    (board as unknown as { tokens: Map<string, { until: number; owner: string }> }).tokens.set(token, { until: Date.now() - 1, owner: ANA });
    assert.equal(board.isOwnedBy(token, ANA), false);
    assert.deepEqual(board.since(token, ANA), []);
  });
});

describe('what a request tells us', () => {
  test('headers are kept, and the secret ones are not', () => {
    const d = describeRequest(
      {
        'sec-fetch-dest': 'image',
        referer: 'http://intranet.corp/orders',
        'x-forwarded-for': '10.4.2.19, 172.16.0.3',
        cookie: 'session=supersecret',
        authorization: 'Bearer supersecret',
        'user-agent': 'Chrome/155',
      },
      '127.0.0.1',
      'GET',
      '/ping/img/K3F9abcd',
    );
    assert.equal(d.dest, 'image');
    assert.equal(d.method, 'GET');
    assert.equal(d.headers['x-forwarded-for'], '10.4.2.19, 172.16.0.3');
    assert.ok(!('cookie' in d.headers), 'a live session must not be stored where anyone can read it');
    assert.ok(!('authorization' in d.headers));
    assert.deepEqual(d.withheld?.sort(), ['authorization', 'cookie']);
    assert.ok(!JSON.stringify(d).includes('supersecret'));
  });

  test('a repeated header is joined, not dropped', () => {
    const d = describeRequest({ 'accept-encoding': ['gzip', 'br'] }, undefined);
    assert.equal(d.headers['accept-encoding'], 'gzip, br');
  });

  test('each arrival gets its own id', () => {
    const a = describeRequest({}, undefined);
    const b = describeRequest({}, undefined);
    assert.notEqual(a.id, b.id);
  });
});

describe('probe urls', () => {
  test('every probe has a path, and it round-trips', () => {
    for (const probe of PROBES) {
      const parsed = parseProbePath(`/ping/${probe}/K3F9abcd`);
      assert.deepEqual(parsed, { probe, token: 'K3F9abcd' });
    }
  });

  test('nonsense is refused rather than guessed at', () => {
    assert.equal(parseProbePath('/ping/notaprobe/K3F9abcd'), null);
    assert.equal(parseProbePath('/ping/img/with/extra'), null);
    assert.equal(parseProbePath('/ping/img/'), null);
    assert.equal(parseProbePath('/ping/img/short'), null, 'too short to be one of ours');
    assert.equal(parseProbePath('/ping/img/..%2F..%2Fetc'), null);
    assert.equal(parseProbePath('/asset/img/K3F9abcd'), null);
  });
});

describe('the second-stage script', () => {
  const body = scriptProbeBody('http://relay:7331', 'K3F9abcd', 'ws://relay:7331');

  /**
   * Run it the way a page would and watch what it reaches for. The page's own
   * response is served by the fake fetch, so the framing headers it reports
   * can be steered per case.
   */
  function run(opts: { failFetch?: boolean; noWebSocket?: boolean; xfo?: string; csp?: string; pageFails?: boolean } = {}) {
    const fetched: string[] = [];
    const sockets: string[] = [];
    const PAGE = 'http://intranet.example/app';
    const fakeFetch = (url: string, init?: { method?: string }) => {
      // The page asking about itself, which is the framing check.
      if (url === PAGE) {
        if (opts.pageFails) return Promise.reject(new Error('blocked'));
        return Promise.resolve({
          ok: true,
          headers: {
            get: (name: string) =>
              name === 'x-frame-options' ? (opts.xfo ?? '') : name === 'content-security-policy' ? (opts.csp ?? '') : '',
          },
          _method: init?.method,
        });
      }
      fetched.push(url);
      return opts.failFetch ? Promise.reject(new Error('blocked by CSP')) : Promise.resolve({});
    };
    function FakeSocket(this: Record<string, unknown>, url: string) {
      if (opts.noWebSocket) throw new Error('blocked by CSP');
      sockets.push(url);
      this.close = () => {};
    }
    const fn = new Function('fetch', 'WebSocket', 'location', body) as (f: unknown, w: unknown, l: unknown) => void;
    fn(fakeFetch, FakeSocket, { href: PAGE });
    return { fetched, sockets, settled: () => new Promise((r) => setTimeout(r, 0)) };
  }

  test('reaches for exactly the two connection probes', async () => {
    const { fetched, sockets, settled } = run();
    await settled();
    await settled();
    assert.equal(fetched.length, 1);
    assert.ok(fetched[0]!.startsWith('http://relay:7331/ping/fetch/K3F9abcd?page='));
    assert.deepEqual(sockets, ['ws://relay:7331/ping/websocket/K3F9abcd']);
  });

  test('tells the relay which page it is on', async () => {
    const { fetched, settled } = run();
    await settled();
    await settled();
    assert.match(fetched[0]!, /page=http%3A%2F%2Fintranet\.example%2Fapp/);
  });

  test('reports what the page says about being framed', async () => {
    const { fetched, settled } = run({ xfo: 'DENY', csp: "default-src 'self'; frame-ancestors 'none'" });
    await settled();
    await settled();
    assert.match(fetched[0]!, /xfo=DENY/);
    assert.match(fetched[0]!, /fa=frame-ancestors(%20|\+)'none'/i);
  });

  test('a page that will not answer about itself still reports the rest', async () => {
    // The framing question is an extra, never a gate on the connection probes.
    const { fetched, sockets, settled } = run({ pageFails: true });
    await settled();
    await settled();
    assert.equal(fetched.length, 1, 'the fetch probe still went');
    assert.equal(sockets.length, 1, 'and so did the socket');
    assert.ok(!/xfo=/.test(fetched[0]!), 'with nothing claimed about framing');
  });

  test('does not fire the HTML-driven probes', async () => {
    // Firing img or style from here would hide a script-src problem: they
    // would only ever arrive when scripts were allowed anyway.
    const { fetched, sockets, settled } = run();
    await settled();
    await settled();
    for (const url of [...fetched, ...sockets]) {
      assert.ok(!url.includes('/ping/img/') && !url.includes('/ping/style/'), url);
    }
  });

  test('one blocked mechanism does not stop the other', async () => {
    const a = run({ failFetch: true });
    await a.settled();
    await a.settled();
    assert.equal(a.sockets.length, 1, 'a rejected fetch must not take the socket with it');
    const b = run({ noWebSocket: true });
    await b.settled();
    await b.settled();
    assert.equal(b.fetched.length, 1, 'a WebSocket the page forbids must not stop the fetch');
  });
});

describe('tokens outliving the relay', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-ping-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, 'ping-tokens.json');

  test('a token issued before a restart is still honoured after it', async () => {
    // The whole point of the Webhook tab is to paste a URL somewhere and come
    // back to it. A token good for a week, held only in memory, made that fail
    // in the worst way available: the probe still got a 200, so the page
    // looked fine and the tab stayed empty.
    const before = new PingBoard();
    before.useFile(file());
    const { token } = before.issue(ANA);

    const after = new PingBoard();
    after.useFile(file());
    assert.equal(after.knows(token), true);
  });

  test('a lapsed token is not brought back by the file', async () => {
    await fs.writeFile(file(), JSON.stringify({ staleToken12: { until: Date.now() - 1000, owner: ANA } }));
    const board = new PingBoard();
    board.useFile(file());
    assert.equal(board.knows('staleToken12'), false);
  });

  test('rubbish in the file is ignored rather than trusted', async () => {
    await fs.writeFile(
      file(),
      JSON.stringify({
        'bad token': { until: Date.now() + 60_000, owner: ANA },
        ok12345678: { until: 'not a number', owner: ANA },
        noowner1234: { until: Date.now() + 60_000 },
      }),
    );
    const board = new PingBoard();
    board.useFile(file());
    assert.equal(board.knows('bad token'), false);
    assert.equal(board.knows('ok12345678'), false);
    assert.equal(board.knows('noowner1234'), false, 'a token with no owner is nobody’s');
  });

  test('an unreadable file leaves an empty board rather than stopping the relay', () => {
    const board = new PingBoard();
    assert.doesNotThrow(() => board.useFile(path.join(dir, 'does', 'not', 'exist.json')));
    const { token } = board.issue(ANA);
    assert.equal(board.knows(token), true, 'and issuing still works');
  });

  test('every live token is written, not only the newest', () => {
    const board = new PingBoard();
    board.useFile(file());
    const a = board.issue(ANA).token;
    const b = board.issue(ANA).token;
    const reopened = new PingBoard();
    reopened.useFile(file());
    assert.equal(reopened.knows(a), true);
    assert.equal(reopened.knows(b), true);
  });
});
