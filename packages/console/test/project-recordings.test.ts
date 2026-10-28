import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRecordings } from '../src/panels/sessions/project-counts';

test('a project with nothing in it says so, rather than counting to zero', () => {
  assert.equal(describeRecordings(undefined), 'no recordings');
  assert.equal(describeRecordings({ live: 0, kept: 0 }), 'no recordings');
});

test('with nothing live, the card is the total alone', () => {
  // "0 live" on every card of a relay nobody is running a payload against
  // says what the grey dot beside the name already said.
  assert.equal(describeRecordings({ live: 0, kept: 19 }), '19 recordings');
});

test('the live count is against the total, which includes it', () => {
  assert.equal(describeRecordings({ live: 2, kept: 19 }), '2 live · 21 recordings');
});

test('one recording is a recording', () => {
  assert.equal(describeRecordings({ live: 0, kept: 1 }), '1 recording');
  assert.equal(describeRecordings({ live: 1, kept: 0 }), '1 live · 1 recording');
});
