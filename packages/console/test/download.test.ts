/**
 * Handing a value to the operator as a file.
 *
 * Everything saved here is already in the page, so none of it asks the relay
 * for anything — and a string the agent had to cut must not be filed away
 * under a name that claims it is the whole of it.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

interface Saved { text: string; filename: string; type: string }
let saved: Saved[] = [];
let revoked = 0;

function stubDom() {
  saved = [];
  revoked = 0;
  const g = globalThis as Record<string, unknown>;
  let lastBlob: { text: string; type: string } | null = null;
  g.Blob = class {
    constructor(parts: string[], opts: { type: string }) {
      lastBlob = { text: parts.join(''), type: opts.type };
    }
  };
  // The two statics only. Replacing URL outright breaks `new URL(...)`, which
  // other modules in the graph use.
  const U = g.URL as unknown as { createObjectURL: unknown; revokeObjectURL: unknown };
  U.createObjectURL = () => 'blob:stub';
  U.revokeObjectURL = () => { revoked++; };
  g.document = {
    createElement: () => {
      const a = { href: '', download: '', click: () => saved.push({ text: lastBlob!.text, filename: a.download, type: lastBlob!.type }) };
      return a;
    },
  };
  g.setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown;
}

beforeEach(stubDom);

const load = async () => (await import(`../src/devtools-ui/download?x=${Math.random()}`)) as typeof import('../src/devtools-ui/download');

describe('saving text', () => {
  test('the bytes handed over are the bytes asked for', async () => {
    const { downloadText } = await load();
    downloadText('hello\nworld', 'a.txt');
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.text, 'hello\nworld');
    assert.equal(saved[0]!.filename, 'a.txt');
  });

  test('it says utf-8, or a browser guesses and mangles non-ascii', async () => {
    const { downloadText } = await load();
    downloadText('세션 기록', 'b.txt');
    assert.match(saved[0]!.type, /charset=utf-8/);
  });

  test('the type can be set, for the HAR that shares this', async () => {
    const { downloadText } = await load();
    downloadText('{}', 'c.har', 'application/json');
    assert.match(saved[0]!.type, /^application\/json/);
  });

  test('the blob url is released rather than held for the page’s life', async () => {
    const { downloadText } = await load();
    downloadText('x', 'd.txt');
    assert.equal(revoked, 1);
  });

  test('a very large string is passed through whole', async () => {
    const { downloadText } = await load();
    const big = 'x'.repeat(64 * 1024);
    downloadText(big, 'e.txt');
    assert.equal(saved[0]!.text.length, big.length);
  });
});

describe('the filename', () => {
  test('it carries a stamp, so two saves do not collide', async () => {
    const { stampedName } = await load();
    assert.match(stampedName('console-value', 'txt'), /^console-value-\d{8}-\d{6}\.txt$/);
  });

  test('a partial string is named as one', async () => {
    const { stampedName } = await load();
    // The caller picks the stem; what matters is that "partial" can be said.
    assert.match(stampedName('console-value-partial', 'txt'), /^console-value-partial-/);
  });

  test('the size is in the name, so two saves in one second differ', async () => {
    const { stampedName } = await load();
    const a = stampedName('console-value', 'txt', 5000);
    const b = stampedName('console-value', 'txt', 20000);
    assert.match(a, /^console-value-5000chars-\d{8}-\d{6}\.txt$/);
    assert.notEqual(a, b, 'the clock alone gave both the same name');
  });
});

describe('a stem that came from the page', () => {
  test('a host with a port does not put a colon in a filename', async () => {
    // Illegal on Windows, and the Finder shows it as a slash.
    const { stampedName } = await load();
    assert.match(stampedName('localhost:7331', 'har'), /^localhost-7331-\d{8}-\d{6}\.har$/);
  });

  test('an IPv6 host comes out as something nameable', async () => {
    const { stampedName } = await load();
    const name = stampedName('[2001:db8::1]:8443', 'har');
    assert.ok(!/[^A-Za-z0-9._-]/.test(name.replace(/\.har$/, '')), name);
    assert.ok(!name.startsWith('-'), name);
  });

  test('an ordinary host is left looking like itself', async () => {
    const { stampedName } = await load();
    assert.match(stampedName('intranet.corp.example', 'har'), /^intranet\.corp\.example-\d{8}-\d{6}\.har$/);
  });

  test('a stem with nothing nameable in it still makes a file', async () => {
    const { stampedName } = await load();
    assert.match(stampedName('://', 'har'), /^download-\d{8}-\d{6}\.har$/);
  });
});
