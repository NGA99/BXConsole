import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMeta } from '@bxconsole/protocol';
import { projectCounts, describeCount } from '../src/panels/sessions/project-counts';

const run = (over: Partial<SessionMeta>): SessionMeta =>
  ({ sessionId: 'a', url: 'http://x/', startedAt: 0, lastSeenAt: 0, connected: false, ...over }) as SessionMeta;

test('what is in the trash is not in the count', () => {
  // The number the path row shows sits one row above the Sessions tab's own,
  // and the two disagreeing is the bug this exists to stop.
  const counts = projectCounts(
    [
      run({ sessionId: '1', projectId: 'p', connected: true }),
      run({ sessionId: '2', projectId: 'p' }),
      run({ sessionId: '3', projectId: 'p', trashedAt: 1 }),
    ],
    'home',
  );
  assert.deepEqual(counts.get('p'), { live: 1, kept: 1 });
});

test('a run with no project of its own belongs to the home one', () => {
  // The relay reads them that way, so leaving them out would be short by
  // every payload that carried no key.
  const counts = projectCounts([run({ sessionId: '1' }), run({ sessionId: '2', projectId: 'p' })], 'home');
  assert.deepEqual(counts.get('home'), { live: 0, kept: 1 });
  assert.deepEqual(counts.get('p'), { live: 0, kept: 1 });
});

test('with no home project those runs are counted nowhere rather than somewhere wrong', () => {
  assert.equal(projectCounts([run({ sessionId: '1' })], null).size, 0);
});

test('a project nothing has landed in is absent, not zero', () => {
  assert.equal(projectCounts([], 'home').get('home'), undefined);
  assert.equal(describeCount(undefined), '');
});

test('the label says only what there is', () => {
  assert.equal(describeCount({ live: 2, kept: 3 }), '2 live · 3 recorded');
  assert.equal(describeCount({ live: 2, kept: 0 }), '2 live');
  assert.equal(describeCount({ live: 0, kept: 3 }), '3 recorded');
  assert.equal(describeCount({ live: 0, kept: 0 }), '');
});
