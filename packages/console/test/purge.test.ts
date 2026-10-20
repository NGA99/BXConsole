/**
 * What the trash says about its own deadline.
 *
 * Worth its own test because the trash is the one place in this console
 * where doing nothing is itself an action: leave a recording there and in a
 * week it is gone, with nobody to ask. A count and no deadline reads as a
 * list that will keep.
 *
 * The figure is the relay's, not a constant here, so a relay configured
 * differently — or with the purge switched off — says what it will actually
 * do.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeNote, purgeSummary } from '../src/panels/sessions/purge';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const ago = (ms: number) => NOW - ms;

describe('how long it has left', () => {
  test('a full window left reads as the whole window', () => {
    assert.equal(purgeNote(NOW, 7, NOW), 'deleted in 7 days');
  });

  test('part of a day counts as a day, so nothing reads as “0 days”', () => {
    // Something with four hours left has neither a day left nor none.
    assert.equal(purgeNote(ago(6 * DAY), 7, NOW), 'deleted today');
    assert.equal(purgeNote(ago(6 * DAY + 20 * 60 * 60 * 1000), 7, NOW), 'deleted today');
  });

  test('a day and a bit still reads as two days rather than one', () => {
    // Just over a day left: rounding down would promise a day it does not
    // have, so it rounds up and says two.
    assert.equal(purgeNote(ago(6 * DAY - 60_000), 7, NOW), 'deleted in 2 days');
    assert.equal(purgeNote(ago(5 * DAY), 7, NOW), 'deleted in 2 days');
  });

  test('past the window it says the next sweep, not a negative number', () => {
    // It runs hourly, so something past its date has not gone yet.
    assert.equal(purgeNote(ago(8 * DAY), 7, NOW), 'deleted at the next sweep');
    assert.equal(purgeNote(ago(400 * DAY), 7, NOW), 'deleted at the next sweep');
  });

  test('nothing to say for something that is not in the trash', () => {
    assert.equal(purgeNote(undefined, 7, NOW), null);
  });

  test('nothing to say when the relay empties nothing on a timer', () => {
    // Saying "deleted in 0 days" about a trash nobody empties would be the
    // worst of both: a deadline that is not one.
    assert.equal(purgeNote(ago(400 * DAY), 0, NOW), null);
    assert.equal(purgeSummary(0), null);
  });
});

describe('what the list says about itself', () => {
  test('it names the relay’s own figure', () => {
    assert.equal(purgeSummary(7), 'Anything left here is deleted for good after 7 days.');
    assert.equal(purgeSummary(30), 'Anything left here is deleted for good after 30 days.');
  });

  test('one day is said as a day, not as “1 days”', () => {
    assert.equal(purgeSummary(1), 'Anything left here is deleted for good after a day.');
  });
});
