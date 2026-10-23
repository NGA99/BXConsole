/**
 * Ids that stay unique across the windows of one run, and across its reloads.
 *
 * Request ids and object ids are counters that restart at 1 in every
 * document. The console indexes both by id alone, so two windows of one
 * session — or two loads of one window — producing the same `r1` means a
 * reply landing on the wrong row, or an expand answered from the previous
 * document's cache. The prefix is the whole defence and had no test.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/** A fresh copy, because the prefix is module state. */
async function freshIds() {
  return (await import(`../src/ids?${Math.random()}`)) as {
    setIdPrefix: (tabId: string) => void;
    scopedId: (v: string | number) => string;
  };
}

describe('scoped ids', () => {
  test('two windows of one run never produce the same id', async () => {
    const a = await freshIds();
    const b = await freshIds();
    a.setIdPrefix('tabAAAA');
    b.setIdPrefix('tabBBBB');
    assert.notEqual(a.scopedId('r1'), b.scopedId('r1'));
  });

  test('two loads of the same window never produce the same id', async () => {
    // The tab id survives a reload; the document token is what does not.
    const first = await freshIds();
    const second = await freshIds();
    first.setIdPrefix('tabAAAA');
    second.setIdPrefix('tabAAAA');
    assert.notEqual(first.scopedId('r1'), second.scopedId('r1'), 'a reload repeated the previous document’s ids');
  });

  test('the window is named in the id, so a reply can be traced to it', async () => {
    const ids = await freshIds();
    ids.setIdPrefix('tab1234');
    assert.match(ids.scopedId('r7'), /^tab1234\./);
    assert.match(ids.scopedId('r7'), /r7$/);
  });

  test('counters stay distinct within one window', async () => {
    const ids = await freshIds();
    ids.setIdPrefix('tabAAAA');
    const seen = new Set([ids.scopedId(1), ids.scopedId(2), ids.scopedId('o1')]);
    assert.equal(seen.size, 3);
  });

  test('being re-prefixed does not reuse the ids of the prefix before it', async () => {
    // The relay settles window identity: told it is a different window, the
    // agent re-prefixes, and the ids from before must not come round again.
    const ids = await freshIds();
    ids.setIdPrefix('tabAAAA');
    const before = ids.scopedId('r1');
    ids.setIdPrefix('tabCCCC');
    assert.notEqual(ids.scopedId('r1'), before);
  });
});
