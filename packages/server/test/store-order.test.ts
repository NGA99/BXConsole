/**
 * A recording is read back in seq order, and the merge that does it assumes
 * each file is already nearly sorted. Appending a body to the blob store
 * before writing its line made that assumption breakable: an event that has
 * to wait could be overtaken by one that does not, and the Network tab would
 * show a response before its request.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SESSION_FILES, sessionDirName } from '@bxconsole/protocol';
import { SessionStore } from '../src/store';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-order-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const event = (seq: number) => ({ seq, tabId: 't1', event: { type: 'network.finished', ts: seq, requestId: `r${seq}`, durationMs: 1 } }) as never;
const after = (ms: number, value: unknown) => new Promise((r) => setTimeout(() => r(value), ms));

const makeDir = (sessionId: string) => fs.mkdir(path.join(dir, sessionDirName(sessionId)), { recursive: true });

async function seqs(sessionId: string): Promise<number[]> {
  const text = await fs.readFile(path.join(dir, sessionDirName(sessionId), SESSION_FILES.network), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { seq: number }).seq);
}

describe('append order', () => {
  test('a slow event is not overtaken by the ones behind it', async () => {
    const store = new SessionStore(dir);
    await makeDir('s1');
    // seq 1 has to wait on a body write; 2 and 3 have nothing to wait for.
    const slow = after(40, event(1)) as Promise<never>;
    const a = store.appendEvent('s1', slow);
    const b = store.appendEvent('s1', event(2));
    const c = store.appendEvent('s1', event(3));
    await Promise.all([a, b, c]);
    assert.deepEqual(await seqs('s1'), [1, 2, 3]);
  });

  test('a body write that fails does not swallow the events behind it', async () => {
    const store = new SessionStore(dir);
    await makeDir('s1');
    const broken = Promise.reject(new Error('blob store is on fire')) as Promise<never>;
    const a = store.appendEvent('s1', broken);
    const b = store.appendEvent('s1', event(2));
    await Promise.all([a, b]);
    assert.deepEqual(await seqs('s1'), [2], 'the one that failed is lost; the rest must not be');
  });

  test('two sessions do not wait on each other', async () => {
    const store = new SessionStore(dir);
    await makeDir('slow');
    await makeDir('quick');
    const held = store.appendEvent('slow', after(60, event(1)) as Promise<never>);
    await store.appendEvent('quick', event(1));
    assert.deepEqual(await seqs('quick'), [1], 'a busy session blocked a quiet one');
    await held;
  });
});
