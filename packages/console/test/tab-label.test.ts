/**
 * What a window's tab tells you before you click it.
 *
 * A run's windows look alike in the strip — the same site, often the same
 * title, five of them reading NAVER — and nothing in it said which one was
 * worth opening. One window of a real session here had produced 1,902 events
 * and another 126, and they were indistinguishable. These are the two places
 * there is room to say so: a number on the tab, and everything else on hover.
 */
import { describe as suite, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionTab } from '@bxconsole/protocol';
import { compact, describe, duration } from '../src/app/tab-label';

const tab = (over: Partial<SessionTab> = {}): SessionTab => ({
  tabId: 't1',
  url: 'http://shop.test/checkout',
  title: '주문 확인',
  viewport: { width: 1440, height: 900, dpr: 1 },
  startedAt: 1_000_000,
  lastSeenAt: 1_000_000 + 65_000,
  connected: true,
  ...over,
});

suite('the number on the tab', () => {
  test('small counts are exact, because the difference between 8 and 126 is the point', () => {
    assert.equal(compact(0), '0');
    assert.equal(compact(8), '8');
    assert.equal(compact(126), '126');
    assert.equal(compact(999), '999');
  });

  test('thousands are shortened rather than crowding out the title', () => {
    assert.equal(compact(1000), '1k');
    assert.equal(compact(1500), '1.5k');
    assert.equal(compact(1900), '1.9k');
    assert.equal(compact(9999), '10k');
  });

  test('past ten thousand the decimal stops earning its place', () => {
    assert.equal(compact(10_000), '10k');
    assert.equal(compact(123_456), '123k');
  });

  test('the step up happens before the rounding does', () => {
    // 999,999 scaled into thousands rounds to 1000, and "1000k" is both wrong
    // and a character over budget. It is 1M.
    assert.equal(compact(999_499), '999k');
    assert.equal(compact(999_999), '1M');
    assert.equal(compact(1_500_000), '1.5M');
    assert.equal(compact(999_999_999), '1B');
  });

  test('nothing comes back longer than four characters', () => {
    // The budget is about 28px beside a title that needs the rest of the tab.
    for (const n of [0, 9, 99, 999, 1000, 1500, 9999, 10_000, 99_999, 999_499, 999_999, 1_500_000, 999_499_999, 999_999_999]) {
      assert.ok(compact(n).length <= 4, `${n} -> ${compact(n)}`);
    }
  });
});

suite('what the hover says', () => {
  test('the title, the whole url, and what the tab had no room for', () => {
    const text = describe(tab(), 1902);
    assert.match(text, /주문 확인/);
    assert.match(text, /http:\/\/shop\.test\/checkout/, 'the tab only shows the path');
    assert.match(text, /1,902 events/, 'the tab rounds this to 1.9k');
    assert.match(text, /1m/, 'how long the window was around');
    assert.match(text, /1440×900/);
    assert.match(text, /Still open/);
  });

  test('a closed window says so instead', () => {
    assert.match(describe(tab({ connected: false }), 3), /Closed/);
    assert.doesNotMatch(describe(tab({ connected: false }), 3), /Still open/);
  });

  test('being opened by another window is only mentioned when it was', () => {
    assert.match(describe(tab({ openedBy: 'other' }), 1), /Opened by another window/);
    assert.doesNotMatch(describe(tab(), 1), /Opened by/);
  });

  test('a window with no title falls back to its url rather than an empty line', () => {
    const text = describe(tab({ title: '' }), 0);
    assert.ok(!text.startsWith('\n'), 'the first line is blank');
    assert.match(text.split('\n')[0]!, /shop\.test/);
  });

  test('zero events is said plainly, not hidden', () => {
    // A window that recorded nothing is a fact about the run, not an absence.
    assert.match(describe(tab(), 0), /0 events/);
  });
});

suite('how long a window was around', () => {
  test('read the way someone would say it', () => {
    assert.equal(duration(0), '0s');
    assert.equal(duration(13_000), '13s');
    assert.equal(duration(72_000), '1m');
    assert.equal(duration(2_180_000), '36m');
    assert.equal(duration(3_600_000), '1h 0m');
    assert.equal(duration(7_830_000), '2h 11m');
  });
});
