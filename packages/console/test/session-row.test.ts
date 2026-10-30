/**
 * The six rules a row of the session list is made of.
 *
 * They were written straight into the table and never tested: each one is a
 * boundary, and a boundary that is one off is the kind of thing a reader
 * trusts and should not. The column that says "23h ago" for a run from last
 * week, the badge that reads `0/0`, the tooltip the page wrote backwards.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMeta, SessionTab } from '@bxconsole/protocol';
import { absoluteTimestamp } from '../src/devtools-ui/time';
import { agentTitle, identity, liveWindows, relative, shortenUrl, windowCount } from '../src/panels/sessions/session-row';

const run = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    sessionId: 'abc123',
    name: null,
    url: 'http://app.test/',
    title: '',
    userAgent: '',
    viewport: { width: 0, height: 0, dpr: 1 },
    startedAt: 0,
    lastSeenAt: 0,
    connected: false,
    tabs: [],
    ...over,
  }) as SessionMeta;

const window_ = (over: Partial<SessionTab>): SessionTab =>
  ({ tabId: 't', url: 'http://app.test/', title: '', viewport: { width: 0, height: 0, dpr: 1 }, startedAt: 0, lastSeenAt: 0, connected: false, ...over }) as SessionTab;

describe('what the row calls a session', () => {
  test('all three names, so the one you are searching for is in the tooltip', () => {
    // The name and the page title lost their columns when the row became one
    // line; this is where they went, and the filter still searches both.
    assert.equal(
      identity(run({ name: 'my-app', title: 'Download Python | Python.org', sessionId: 'f0f458b49e28' })),
      'my-app\nDownload Python | Python.org\nsession-f0f458b49e28',
    );
  });

  test('a run with no name of its own is not given a blank line', () => {
    assert.equal(identity(run({ name: null, title: 'Some page', sessionId: 'a1' })), 'Some page\nsession-a1');
    assert.equal(identity(run({ name: null, title: '', sessionId: 'a1' })), 'session-a1');
  });

  test('a name that reverses the text after it is defanged, not drawn', () => {
    /*
     * The page chooses its own name and title, and U+202E reverses
     * everything after it — so `acme‮noisses-elitsoh` reads as
     * "acmehostile-sessions" in the one place whose job is to say which run
     * you are looking at. The mark stays, because a name that quietly lost
     * one would match a name that never had it.
     */
    const out = identity(run({ name: 'acme‮noisses-elitsoh', sessionId: 'a1' }));
    assert.ok(!out.includes('‮'), 'the override survived into the tooltip');
    assert.ok(out.includes('�'), 'nothing marks what was removed');
  });
});

describe('the user agent column', () => {
  test('the viewport goes under the string, because it is not in it', () => {
    assert.equal(
      agentTitle(run({ userAgent: 'Mozilla/5.0 (Macintosh) Chrome/156', viewport: { width: 390, height: 844, dpr: 3 } })),
      'Mozilla/5.0 (Macintosh) Chrome/156\n390×844',
    );
  });

  test('a recording from before the window reported its size says nothing rather than 0×0', () => {
    assert.equal(agentTitle(run({ userAgent: 'UA', viewport: { width: 0, height: 0, dpr: 1 } })), 'UA');
    // One dimension is enough to make the pair meaningless.
    assert.equal(agentTitle(run({ userAgent: 'UA', viewport: { width: 390, height: 0, dpr: 1 } })), 'UA');
  });

  test('no user agent at all is said out loud', () => {
    assert.equal(agentTitle(run({ userAgent: '' })), 'no user agent reported');
  });
});

describe('a URL cut to fit the row', () => {
  test('one that already fits is left exactly as it is', () => {
    const short = 'https://app.test/login';
    assert.equal(shortenUrl(short), short);
    // On the boundary: 100 characters is still a fit.
    const exact = `https://app.test/${'a'.repeat(100 - 'https://app.test/'.length)}`;
    assert.equal(exact.length, 100);
    assert.equal(shortenUrl(exact), exact);
  });

  test('the middle goes, so the origin and the page both survive', () => {
    const long = `https://www.google.com/search?q=m5+ultra${'&pad=x'.repeat(60)}&dpr=2`;
    const cut = shortenUrl(long);
    assert.equal(cut.length, 100, 'the cut has to fit the column it was measured for');
    assert.ok(cut.startsWith('https://www.google.com/search?q=m5+ultra'), 'the origin was cut away');
    assert.ok(cut.endsWith('&dpr=2'), 'the tail, which usually says which page, was cut away');
    assert.ok(cut.includes('…'), 'nothing says text was removed');
  });

  test('the budget is spent 60/40, head over tail', () => {
    // Deliberate: the origin is what you scan for, the tail is what tells
    // two rows on one endpoint apart. 99 characters of text, 60 and 39.
    const long = 'x'.repeat(40) + 'y'.repeat(120);
    const cut = shortenUrl(long);
    assert.equal(cut.indexOf('…'), 60);
    assert.equal(cut.length - cut.indexOf('…') - 1, 39);
  });

  test('a shorter column is honoured', () => {
    assert.equal(shortenUrl('abcdefghij', 5).length, 5);
  });
});

describe('how many windows the run holds', () => {
  test('a run that opened another counts both, and says how many are still live', () => {
    // The badge is why a row is a run and not a window: `1/3` is a flow that
    // went three deep and has one window left open.
    const s = run({
      connected: true,
      tabs: [window_({ tabId: 'a', connected: false }), window_({ tabId: 'b', connected: true }), window_({ tabId: 'c', connected: false })],
    });
    assert.equal(windowCount(s), 3);
    assert.equal(liveWindows(s), 1);
  });

  test('the ordinary one-window run reads 1/1 live and 0/1 closed', () => {
    const live = run({ connected: true, tabs: [window_({ connected: true })] });
    assert.equal(`${liveWindows(live)}/${windowCount(live)}`, '1/1');
    const gone = run({ connected: false, tabs: [window_({ connected: false })] });
    assert.equal(`${liveWindows(gone)}/${windowCount(gone)}`, '0/1');
  });

  test('a recording from before windows were reported is the one window it was', () => {
    /*
     * Never `0/0`, which would say the payload fired and opened nothing.
     * `tabs` is required of everything the relay sends today, so this is
     * only reached by a recording made before the field existed — and those
     * still have to open.
     */
    const old = run({ connected: false, tabs: undefined as unknown as SessionTab[] });
    assert.equal(`${liveWindows(old)}/${windowCount(old)}`, '0/1');
    const oldLive = run({ connected: true, tabs: undefined as unknown as SessionTab[] });
    assert.equal(`${liveWindows(oldLive)}/${windowCount(oldLive)}`, '1/1');
  });
});

describe('how long ago, on the boundaries', () => {
  const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
  const ago = (ms: number) => relative(NOW - ms, NOW);

  test('the first minute is "just now" and the next one is not', () => {
    assert.equal(ago(0), 'just now');
    assert.equal(ago(59_999), 'just now');
    assert.equal(ago(60_000), '1m ago');
  });

  test('minutes run to the hour, then hand over to hours', () => {
    assert.equal(ago(59 * 60_000), '59m ago');
    assert.equal(ago(3_599_999), '59m ago');
    assert.equal(ago(3_600_000), '1h ago');
  });

  test('hours run to the day, then hand over to the clock', () => {
    assert.equal(ago(23 * 3_600_000), '23h ago');
    assert.equal(ago(86_399_999), '23h ago');
    // Past a day a relative age stops answering anything useful: the column
    // is read against a server log, so it becomes a timestamp.
    const old = NOW - 86_400_000;
    assert.equal(relative(old, NOW), absoluteTimestamp(old));
  });

  test('a clock running ahead of ours reads as now, not as a negative age', () => {
    // The agent stamps events with the page's clock, and a target machine
    // minutes ahead would otherwise produce "-3m ago".
    assert.equal(relative(NOW + 5 * 60_000, NOW), 'just now');
  });
});
