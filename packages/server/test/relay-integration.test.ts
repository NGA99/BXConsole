/**
 * The relay with agents and consoles attached, which is the layer where the
 * pieces meet and where nothing was covered.
 *
 * The invariants here are the ones that are invisible until a recording is
 * read back weeks later: that what a console is shown and what goes to disk
 * are allowed to differ but must say the same thing; that two windows of one
 * run stay one run; and that a page reconnecting does not take the recording
 * with it.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { SESSION_FILES, sessionDirName } from '@bxconsole/protocol';
import { SessionStore } from '../src/store';
import { SessionRegistry } from '../src/registry';
import { BlobStore } from '../src/blobs';
import { Relay } from '../src/relay';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-relay-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Just enough of a socket for the relay: it sends, it receives, it closes. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly handlers = new Map<string, Array<(arg: unknown) => void>>();

  on(event: string, fn: (arg: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    for (const fn of this.handlers.get('close') ?? []) fn(undefined);
  }
  /** Deliver a message as the page would, and let the relay get to work on it. */
  async deliver(msg: unknown): Promise<void> {
    for (const fn of this.handlers.get('message') ?? []) fn(JSON.stringify(msg));
    await settle();
  }
  received(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

/**
 * Let the relay's own promise chains run out.
 *
 * The relay answers a message through several awaits — a meta write, an
 * append chain, sometimes a blob write — and none of them is observable from
 * here. Waiting a fixed number of milliseconds made these tests fail on a
 * loaded machine and pass on an idle one, which is worse than not having
 * them; `until` waits for the thing the test is actually about.
 */
const settle = () => new Promise((r) => setTimeout(r, 5));

async function until<T>(get: () => T | Promise<T>, what: string, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await get();
    if (got) return got as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The recorded lines of a file, once there are as many as the test expects. */
const recorded = (sessionId: string, file: keyof typeof SESSION_FILES, count = 1) =>
  until(async () => {
    const lines = await linesOf(sessionId, file);
    return lines.length >= count ? lines : undefined;
  }, `${count} line(s) in ${file}.ndjson`);

function build(budget = Number.POSITIVE_INFINITY) {
  const store = new SessionStore(dir);
  const registry = new SessionRegistry(store);
  const relay = new Relay(registry, store);
  const blobs = new BlobStore(dir, budget);
  relay.useBlobs(blobs);
  return { store, registry, relay, blobs };
}

/**
 * Attach a window and wait for its acknowledgement before sending anything.
 *
 * This is what the real agent does — transport.ts holds every event until
 * `session.ack` arrives and only then flushes — and it matters: the relay
 * drops events that arrive before the hello has been processed, so a test
 * that fires straight after the hello is racing a write it cannot see.
 */
async function join(relay: Relay, over: Record<string, unknown> = {}): Promise<FakeSocket> {
  const agent = new FakeSocket();
  relay.attachAgent(agent as unknown as WebSocket);
  await agent.deliver(hello(over));
  await until(() => agent.received('session.ack')[0], 'the hello to be acknowledged');
  return agent;
}

const hello = (over: Record<string, unknown> = {}) => ({
  type: 'session.hello',
  hello: {
    sessionId: 'sess01',
    tabId: 'tabA',
    tabStartedAt: 1000,
    name: 'run',
    url: 'http://app.test/',
    title: 'app',
    userAgent: 'test',
    viewport: { width: 800, height: 600, dpr: 1 },
    startedAt: 1000,
    ...over,
  },
});

const response = (body: string, over: Record<string, unknown> = {}) => ({
  type: 'network.response',
  ts: 2,
  requestId: 'r1',
  status: 200,
  statusText: 'OK',
  headers: {},
  mimeType: 'application/json',
  body,
  ...over,
});

async function linesOf(sessionId: string, file: keyof typeof SESSION_FILES): Promise<Array<Record<string, any>>> {
  try {
    const text = await fs.readFile(path.join(dir, sessionDirName(sessionId), SESSION_FILES[file]), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('a page joining a run', () => {
  test('a hello is acknowledged with the ids the relay actually used', async () => {
    const { relay } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    await agent.deliver(hello());
    const ack = await until(() => agent.received('session.ack')[0], 'the hello to be acknowledged');
    assert.equal(ack.sessionId, 'sess01');
    assert.equal(ack.tabId, 'tabA');
  });

  test('two live windows claiming one id do not fight over it forever', async () => {
    // Duplicating a tab copies sessionStorage without giving the copy an
    // opener, so both pages believe they are the same window. Letting the
    // second in as "a reload" closes the first, which reconnects and closes
    // the second, and so on.
    const { relay } = build();
    const first = new FakeSocket();
    const second = new FakeSocket();
    relay.attachAgent(first as unknown as WebSocket);
    relay.attachAgent(second as unknown as WebSocket);
    await first.deliver(hello());
    await second.deliver(hello());
    const a = await until(() => first.received('session.ack')[0], 'the first ack');
    const b = await until(() => second.received('session.ack')[0], 'the second ack');
    assert.equal(a.sessionId, b.sessionId, 'both are the same run');
    assert.notEqual(a.tabId, b.tabId, 'but not the same window');
    assert.equal(first.readyState, first.OPEN, 'the first window must not have been closed');
  });

  test('a reload of one window supersedes that window, not the run', async () => {
    const { relay, registry } = build();
    const before = new FakeSocket();
    relay.attachAgent(before as unknown as WebSocket);
    await before.deliver(hello());
    before.close();
    await settle();

    const after = new FakeSocket();
    relay.attachAgent(after as unknown as WebSocket);
    await after.deliver(hello());
    const meta = registry.get('sess01')!.meta;
    assert.equal(meta.connected, true);
    assert.equal(meta.tabs.length, 1, 'a reload is the same window, not a new one');
  });

  test('events before a hello are dropped rather than written somewhere', async () => {
    const { relay } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    await agent.deliver(response('{"early":true}'));
    assert.deepEqual(await linesOf('sess01', 'network'), []);
  });

  test('a hello naming a path for a session id is refused', async () => {
    const { relay, registry } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    await agent.deliver(hello({ sessionId: '../../etc/passwd' }));
    assert.equal(agent.received('session.ack').length, 0);
    assert.equal(registry.all().length, 0);
  });

  test('a malformed message does not take the connection down', async () => {
    const { relay, registry } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    for (const junk of ['not json', '[]', '{"type":42}', 'null']) {
      for (const fn of (agent as any).handlers.get('message') ?? []) fn(junk);
    }
    await settle();
    await agent.deliver(hello());
    assert.equal(registry.all().length, 1, 'the socket still works afterwards');
  });
});

describe('what the console sees and what the disk keeps', () => {
  test('a live console gets the body; the recording keeps a reference to it', async () => {
    const { relay, registry } = build();
    const agent = await join(relay);
    const console_ = new FakeSocket();
    relay.attachConsole(console_ as unknown as WebSocket);
    registry.get('sess01')!.subscribers.add(console_ as unknown as WebSocket);

    const big = JSON.stringify({ rows: 'x'.repeat(5000) });
    await agent.deliver(response(big));

    const forwarded = await until(() => console_.received('session.event')[0]?.event as Record<string, unknown>, 'the event to reach the console');
    assert.equal(forwarded.body, big, 'the console already has the bytes; it must not be made to fetch them');
    assert.equal(forwarded.bodyRef, undefined);

    const [line] = await recorded('sess01', 'network');
    assert.equal(line!.event.body, undefined, 'the recording should not carry it inline');
    assert.match(String(line!.event.bodyRef), /^[0-9a-f]{64}$/);
    assert.equal(line!.event.bodyBytes, Buffer.byteLength(big));
  });

  test('a small body is left where it is, and is still there to read', async () => {
    const { relay } = build();
    const agent = await join(relay);
    await agent.deliver(response('{"ok":1}'));
    const [line] = await recorded('sess01', 'network');
    assert.equal(line!.event.body, '{"ok":1}');
    assert.equal(line!.event.bodyRef, undefined);
  });

  test('the bytes behind a reference come back byte for byte, non-ASCII included', async () => {
    const { relay, blobs } = build();
    const agent = await join(relay);
    const body = JSON.stringify({ note: 'çafé — naïve ☕ '.repeat(400) });
    await agent.deliver(response(body));
    const [line] = await recorded('sess01', 'network');
    await blobs.whenQuiet('sess01');
    const held = await blobs.read(String(line!.event.bodyRef));
    assert.equal(held?.toString('utf8'), body);
  });

  test('a body the store refuses stays inline: a recording never loses one', async () => {
    const { relay, blobs } = build(10); // a budget nothing will fit in
    const agent = await join(relay);
    const big = 'y'.repeat(5000);
    await agent.deliver(response(big));
    const [line] = await recorded('sess01', 'network');
    await blobs.whenQuiet('sess01');
    assert.equal(line!.event.body, big, 'refused by the budget, so it must still be in the line');
    assert.equal(line!.event.bodyRef, undefined);
  });

  test('events stay in seq order even though some of them wait on a blob write', async () => {
    const { relay } = build();
    const agent = await join(relay);
    // Alternate expensive and cheap, which is what a real page does.
    for (let i = 0; i < 8; i++) {
      await agent.deliver(response(i % 2 ? '{"small":1}' : JSON.stringify({ big: String(i).repeat(3000) }), { requestId: `r${i}` }));
    }
    const seqs = (await recorded('sess01', 'network', 8)).map((l) => l.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `out of order: ${seqs}`);
    assert.equal(seqs.length, 8, 'nothing was dropped on the way');
  });
});

describe('a run spanning several windows', () => {
  test('a second window joins the run rather than starting one', async () => {
    const { relay, registry } = build();
    await join(relay);
    await join(relay, { tabId: 'tabB', openedBy: 'tabA' });
    assert.equal(registry.all().length, 1);
    const meta = registry.get('sess01')!.meta;
    assert.deepEqual(meta.tabs.map((t) => t.tabId).sort(), ['tabA', 'tabB']);
    assert.equal(meta.tabs.find((t) => t.tabId === 'tabB')?.openedBy, 'tabA');
  });

  test('one window closing leaves the run connected while another is live', async () => {
    const { relay, registry } = build();
    const a = await join(relay);
    const b = await join(relay, { tabId: 'tabB' });
    a.close();
    // Waiting a fixed few milliseconds for the registry to catch up made this
    // pass alone and fail in a full run; the disconnect is written through an
    // async chain that nothing here can see finish.
    await until(() => registry.get('sess01')!.meta.tabs.every((t) => t.tabId !== 'tabA' || !t.connected), 'the first window to be marked gone');
    assert.equal(registry.get('sess01')!.meta.connected, true, 'the run is still live while another window is');
    b.close();
    await until(() => !registry.get('sess01')!.meta.connected, 'the run to be marked offline');
    assert.equal(registry.get('sess01')!.meta.connected, false);
  });

  test('events carry the window they came from, so the tab strip can split them', async () => {
    const { relay } = build();
    const a = await join(relay);
    const b = await join(relay, { tabId: 'tabB' });
    await a.deliver(response('{"from":"a"}', { requestId: 'ra' }));
    await b.deliver(response('{"from":"b"}', { requestId: 'rb' }));
    const byTab = Object.fromEntries((await recorded('sess01', 'network', 2)).map((l) => [l.event.requestId, l.tabId]));
    assert.deepEqual(byTab, { ra: 'tabA', rb: 'tabB' });
  });
});

describe('the collection choice', () => {
  test('it is the run’s, taken from the window that started it', async () => {
    const { relay, registry } = build();
    const a = new FakeSocket();
    relay.attachAgent(a as unknown as WebSocket);
    await a.deliver(hello({ collect: false }));
    const b = new FakeSocket();
    relay.attachAgent(b as unknown as WebSocket);
    await b.deliver(hello({ tabId: 'tabB', collect: true }));
    assert.equal(registry.get('sess01')!.meta.collect, false, 'a later window must not flip the run’s choice');
  });

  test('a recording from before the option existed is treated as collecting', async () => {
    const { registry } = build();
    assert.equal(registry.get('sess01'), undefined);
    // `collect` absent, as every hello sent before the flag existed.
    const { relay, registry: reg2 } = build();
    const a = new FakeSocket();
    relay.attachAgent(a as unknown as WebSocket);
    await a.deliver(hello());
    assert.equal(reg2.get('sess01')!.meta.collect, undefined, 'absent, which the relay reads as on');
  });
});
