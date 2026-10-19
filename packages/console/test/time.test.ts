/**
 * Timestamps in the session list.
 *
 * `absoluteTimestamp` exists because the friendly one cannot be read against
 * anything. "yesterday 21:03" changes meaning while the page is open and has
 * to be converted by hand before it can be matched to a request log, which is
 * most of what a recorded run is compared against.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteTimestamp, clockTimeShort, friendlyTimestamp, fullTimestamp } from '../src/devtools-ui/time';

/** A local-time instant, so the formatter and the assertion agree on the zone. */
const at = (y: number, m: number, d: number, hh: number, mm: number, ss: number) =>
  new Date(y, m - 1, d, hh, mm, ss).getTime();

describe('absoluteTimestamp', () => {
  test('is the date and the clock, dot separated', () => {
    assert.equal(absoluteTimestamp(at(2026, 10, 19, 21, 3, 27)), '2026.10.19 21:03:27');
  });

  test('pads every field, so the column stays one width', () => {
    assert.equal(absoluteTimestamp(at(2026, 1, 2, 3, 4, 5)), '2026.01.02 03:04:05');
    const widths = new Set(
      [at(2026, 1, 2, 3, 4, 5), at(2026, 12, 31, 23, 59, 59), at(2026, 10, 19, 21, 3, 27)].map(
        (t) => absoluteTimestamp(t).length,
      ),
    );
    assert.equal(widths.size, 1, 'every stamp must be the same length');
  });

  test('says the same thing however old it is, unlike the friendly one', () => {
    const now = Date.now();
    // The friendly form answers "today" for one of these and a date for the
    // other; this one does not change its mind.
    for (const ts of [now - 60_000, now - 4 * 24 * 3600_000]) {
      assert.match(absoluteTimestamp(ts), /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/);
    }
  });

  test('it is not the stamp used in tooltips, which is dashed and carries ms', () => {
    // Both exist on purpose, and differ in more than the separator: a tooltip
    // can afford milliseconds where a column cannot. A change to one should
    // not quietly take the other.
    const ts = at(2026, 10, 19, 21, 3, 27);
    assert.equal(fullTimestamp(ts), '2026-10-19 21:03:27.000');
    assert.equal(absoluteTimestamp(ts), '2026.10.19 21:03:27');
  });

  test('its clock half matches the shared one', () => {
    const ts = at(2026, 10, 19, 21, 3, 27);
    assert.ok(absoluteTimestamp(ts).endsWith(clockTimeShort(ts)));
  });
});

describe('friendlyTimestamp still does its job', () => {
  test('today and yesterday are named, older is dated', () => {
    const now = new Date();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
    assert.match(friendlyTimestamp(noon), /^today /);
    assert.match(friendlyTimestamp(noon - 24 * 3600_000), /^yesterday /);
    assert.match(friendlyTimestamp(noon - 9 * 24 * 3600_000), /^\d{4}-\d{2}-\d{2} /);
  });
});
