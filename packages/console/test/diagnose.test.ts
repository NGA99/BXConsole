/**
 * Reading the probe matrix.
 *
 * A wrong sentence here is worse than no sentence: it sends someone to the
 * firewall when the problem is a CSP header, or the other way round. Each
 * case below is a real shape an intranet page comes in.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { agentVerdict, readFraming, readMatrix, snippetFor, tagFor, urlFor, type Arrived } from '../src/panels/sessions/diagnose';

describe('what the matrix says', () => {
  test('nothing arrived is not a finding, so there is no verdict', () => {
    // Saying "the page cannot reach this relay" before anything was pasted
    // anywhere is an accusation with no evidence behind it.
    assert.equal(readMatrix({}), null);
  });

  test('image arrives, script does not: script-src', () => {
    const v = readMatrix({ img: true })!;
    assert.equal(v.tone, 'blocked');
    assert.match(v.detail, /script-src/);
    assert.ok(!/mixed content/.test(v.detail), 'the network is plainly fine, so do not send them there');
  });

  test('image and style arrive, script does not: still script-src', () => {
    assert.match(readMatrix({ img: true, style: true })!.detail, /script-src/);
  });

  test('script runs but neither connection lands: connect-src', () => {
    const v = readMatrix({ img: true, style: true, script: true })!;
    assert.equal(v.tone, 'blocked');
    assert.match(v.detail, /connect-src/);
  });

  test('fetch lands, the socket does not: a proxy eating the upgrade', () => {
    const v = readMatrix({ img: true, style: true, script: true, fetch: true })!;
    assert.equal(v.tone, 'partial');
    assert.match(v.headline, /WebSocket does not/);
  });

  test('the socket lands, fetch does not', () => {
    const v = readMatrix({ img: true, style: true, script: true, websocket: true })!;
    assert.equal(v.tone, 'partial');
    assert.match(v.headline, /fetch does not/);
  });

  test('the agent would work, but a resource kind is blocked', () => {
    // Everything the agent needs is through; only the picture is missing.
    const v = readMatrix({ style: true, script: true, fetch: true, websocket: true })!;
    assert.equal(v.tone, 'partial');
    assert.match(v.detail, /img/);
  });

  test('all five: go install the agent', () => {
    const all: Arrived = { img: true, style: true, script: true, fetch: true, websocket: true };
    const v = readMatrix(all)!;
    assert.equal(v.tone, 'ok');
    assert.match(v.detail, /Install the agent/);
  });

  test('every verdict that exists says something, whatever the combination', () => {
    const probes = ['img', 'style', 'script', 'fetch', 'websocket'] as const;
    for (let bits = 0; bits < 32; bits++) {
      const arrived: Arrived = {};
      probes.forEach((p, i) => {
        if (bits & (1 << i)) arrived[p] = true;
      });
      const v = readMatrix(arrived);
      if (!v) continue;
      assert.ok(v.headline.length > 0 && v.detail.length > 0, `empty verdict for ${bits}`);
      assert.ok(['blocked', 'partial', 'ok'].includes(v.tone));
    }
  });
});

describe('probe urls and tags', () => {
  const origin = 'http://10.1.2.3:7331';

  test('every probe has a url, and the socket speaks ws', () => {
    assert.equal(urlFor(origin, 'img', 'K3F9'), `${origin}/ping/img/K3F9`);
    assert.equal(urlFor(origin, 'fetch', 'K3F9'), `${origin}/ping/fetch/K3F9`);
    assert.equal(urlFor(origin, 'websocket', 'K3F9'), 'ws://10.1.2.3:7331/ping/websocket/K3F9');
    assert.equal(urlFor('https://relay.example', 'websocket', 'K3F9'), 'wss://relay.example/ping/websocket/K3F9');
  });

  test('only the three HTML-driven probes have a tag', () => {
    assert.match(tagFor(origin, 'img', 'K3F9')!, /^<img /);
    assert.match(tagFor(origin, 'style', 'K3F9')!, /^<link /);
    assert.match(tagFor(origin, 'script', 'K3F9')!, /^<script /);
    // These two are fired by the script probe, so there is nothing to paste.
    assert.equal(tagFor(origin, 'fetch', 'K3F9'), null);
    assert.equal(tagFor(origin, 'websocket', 'K3F9'), null);
  });

  test('the combined snippet is those three, in the order the layering needs', () => {
    const lines = snippetFor(origin, 'K3F9').split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^<img /);
    assert.match(lines[1]!, /^<link /);
    assert.match(lines[2]!, /^<script /);
    for (const line of lines) assert.ok(line.includes(`${origin}/ping/`) && line.includes('K3F9'));
  });
});

describe('after every way through is open', () => {
  const page = 'http://intranet.corp/orders?x=1';

  test('a session from that page means it is already being recorded', () => {
    const v = agentVerdict(['http://intranet.corp/other', 'http://elsewhere.test/'], page);
    assert.equal(v.tone, 'ok');
    assert.match(v.headline, /an agent is reporting/);
    assert.match(v.detail, /http:\/\/intranet\.corp/);
  });

  test('no session from that page says so, rather than implying it works', () => {
    // The trap this closes: "connectivity is fine" followed by an empty
    // Sessions list and no idea what else is wrong.
    const v = agentVerdict(['http://elsewhere.test/'], page);
    assert.match(v.detail, /no session has started/);
    assert.match(v.detail, /Install the agent/);
  });

  test('a page we never learned still gets a usable sentence', () => {
    assert.match(agentVerdict([], undefined).detail, /Install the agent/);
    assert.match(agentVerdict([], 'not a url').detail, /Install the agent/);
  });

  test('the origin is what matters, not the path or query', () => {
    assert.match(agentVerdict(['http://intranet.corp/'], 'http://intranet.corp/deep/page?q=2').headline, /an agent is reporting/);
    assert.ok(!/an agent is reporting/.test(agentVerdict(['https://intranet.corp/'], page).headline), 'a different scheme is a different origin');
  });
});

describe('whether the page can be framed', () => {
  const page = 'https://app.intranet.corp/orders';

  test('nothing said means nothing forbids it', () => {
    const f = readFraming('', '', page);
    assert.equal(f.can, true);
    assert.equal(f.silent, true);
  });

  test('X-Frame-Options, in the two values browsers act on', () => {
    assert.equal(readFraming('DENY', '', page).can, false);
    assert.equal(readFraming('deny', '', page).can, false);
    assert.equal(readFraming('SAMEORIGIN', '', page).can, true);
    assert.equal(readFraming(' sameorigin ', '', page).can, true);
  });

  test('ALLOW-FROM is ignored by browsers, so it forbids nothing', () => {
    // Saying "cannot" here would talk someone out of an option that works.
    const f = readFraming('ALLOW-FROM https://other.test', '', page);
    assert.equal(f.can, true);
    assert.match(f.why, /ignored by browsers/);
  });

  test('frame-ancestors wins wherever both are set', () => {
    assert.equal(readFraming('DENY', "frame-ancestors 'self'", page).can, true, 'a permissive CSP beats the old header');
    assert.equal(readFraming('SAMEORIGIN', "frame-ancestors 'none'", page).can, false);
  });

  test('frame-ancestors, in its usual forms', () => {
    assert.equal(readFraming('', "frame-ancestors 'none'", page).can, false);
    assert.equal(readFraming('', "frame-ancestors 'self'", page).can, true);
    assert.equal(readFraming('', 'frame-ancestors *', page).can, true);
    assert.equal(readFraming('', "frame-ancestors 'self' https://portal.test", page).can, true);
  });

  test('a list of other origins means this page is not one of them', () => {
    const f = readFraming('', 'frame-ancestors https://portal.test', page);
    assert.equal(f.can, false);
    assert.match(f.why, /only other origins/);
  });

  test('its own origin in the list counts', () => {
    assert.equal(readFraming('', 'frame-ancestors https://app.intranet.corp', page).can, true);
    assert.equal(readFraming('', 'frame-ancestors app.intranet.corp', page).can, true);
  });

  test('every answer carries a reason', () => {
    for (const [xfo, fa] of [['', ''], ['DENY', ''], ['SAMEORIGIN', ''], ['', "frame-ancestors 'none'"], ['nonsense', '']] as const) {
      assert.ok(readFraming(xfo, fa, page).why.length > 0);
    }
  });
});
