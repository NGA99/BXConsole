/**
 * The rate limit.
 *
 * The property worth testing is the sliding window. A fixed-window counter
 * hands a caller a fresh allowance the moment the period rolls over, which
 * means a password guesser only has to wait for the clock rather than stop.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimit, limitKey } from '../src/limit';

describe('the allowance', () => {
  test('it permits exactly max, then refuses', () => {
    const limit = new RateLimit(3, 60_000);
    assert.deepEqual([limit.allow('a'), limit.allow('a'), limit.allow('a'), limit.allow('a')], [
      true,
      true,
      true,
      false,
    ]);
    limit.stop();
  });

  test('keys do not borrow from each other', () => {
    const limit = new RateLimit(1, 60_000);
    assert.equal(limit.allow('a'), true);
    assert.equal(limit.allow('a'), false);
    assert.equal(limit.allow('b'), true, 'one caller must not lock out another');
    limit.stop();
  });

  test('remaining counts down and stops at zero', () => {
    const limit = new RateLimit(2, 60_000);
    assert.equal(limit.remaining('a'), 2);
    limit.allow('a');
    assert.equal(limit.remaining('a'), 1);
    limit.allow('a');
    limit.allow('a');
    limit.allow('a');
    assert.equal(limit.remaining('a'), 0);
    limit.stop();
  });

  test('a successful sign-in clears the count', () => {
    const limit = new RateLimit(2, 60_000);
    limit.allow('a');
    limit.allow('a');
    assert.equal(limit.allow('a'), false);
    limit.clear('a');
    assert.equal(limit.allow('a'), true, 'an operator who mistyped twice must not be locked out');
    limit.stop();
  });
});

describe('the window', () => {
  test('attempts age out, so the allowance returns', async () => {
    const limit = new RateLimit(2, 120);
    assert.equal(limit.allow('a'), true);
    assert.equal(limit.allow('a'), true);
    assert.equal(limit.allow('a'), false);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(limit.allow('a'), true, 'the window should have slid past both attempts');
    limit.stop();
  });

  test('knocking while refused does not extend the refusal', async () => {
    const limit = new RateLimit(2, 500);
    limit.allow('a'); // t=0
    limit.allow('a'); // t=0

    /*
     * Keep knocking inside the window. Were refused attempts recorded, each
     * knock would push the window out and the caller would never come back;
     * the assertion after the wait is what catches that.
     *
     * The knocks stay well inside 500ms, because an attempt landing on the
     * boundary is legitimately allowed and timers are not precise enough to
     * aim at it.
     */
    for (const at of [100, 200, 300]) {
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(limit.allow('a'), false, `knock at ~${at}ms`);
    }
    // The two real attempts are now older than the window, so one is due.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(limit.allow('a'), true, 'refused knocks must not have been recorded');
    limit.stop();
  });
});

describe('the key', () => {
  test('an address with no name still counts as one caller', () => {
    assert.equal(limitKey(undefined), 'unknown');
    assert.equal(limitKey('127.0.0.1'), '127.0.0.1');
  });
});
