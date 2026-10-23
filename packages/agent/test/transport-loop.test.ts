/**
 * What the transport does when a connection opens and then dies.
 *
 * This is not the same failure as a connection that will not open. The relay
 * drops a socket the moment a message arrives that is past its size limit —
 * so the handshake succeeds, the session is acknowledged, and the link dies
 * anyway, every time, for as long as the page is open. A backoff that counts
 * "opened" as success never grows, and the payload knocks on the relay
 * several times a second from a browser nobody can reach.
 */
import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionHello } from '@bxconsole/protocol';
import { AGENT_MAX_MESSAGE_BYTES } from '@bxconsole/protocol';

let opened: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(readonly url: string) {
    opened.push(this);
  }
  addEventListener(event: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.fire('close', undefined);
  }
  fire(event: string, ev: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(ev);
  }
  deliver(msg: unknown): void {
    this.fire('message', { data: JSON.stringify(msg) });
  }
}

const hello = (): SessionHello =>
  ({
    sessionId: 'sess01',
    tabId: 'tabA',
    tabStartedAt: 1,
    name: null,
    url: 'http://victim.test/',
    title: 'victim',
    userAgent: 'test',
    viewport: { width: 800, height: 600, dpr: 1 },
    startedAt: 1,
  }) as SessionHello;

async function freshTransport() {
  (globalThis as { window?: unknown }).window = { WebSocket: FakeSocket };
  const mod = await import(`../src/transport?${Math.random()}`);
  return mod.Transport as new (url: string, hello: () => SessionHello) => {
    connect(): void;
    send(msg: unknown): void;
    onMessage(h: (msg: unknown) => void): void;
  };
}

beforeEach(() => {
  opened = [];
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
  mock.timers.reset();
  delete (globalThis as { window?: unknown }).window;
});

/** One round of what an oversized message does: open, acknowledge, die. */
function openAckDie(ws: FakeSocket): void {
  ws.fire('open', undefined);
  ws.deliver({ type: 'session.ack' });
  ws.fire('close', undefined);
}

describe('a connection that opens and dies', () => {
  test('backs off instead of knocking at full speed for ever', async () => {
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();

    // Ten rounds, each given the shortest backoff's worth of time.
    for (let i = 0; i < 10; i++) {
      openAckDie(opened[opened.length - 1]!);
      mock.timers.tick(500);
    }

    assert.ok(
      opened.length < 11,
      `every reconnection came back at the first backoff: ${opened.length} sockets in ten short waits`,
    );
  });

  test('a link that lasted still comes straight back', async () => {
    // The backoff is for connections that fail; one that worked for a while
    // and then dropped is an ordinary network blip and must not be punished.
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();
    const first = opened[0]!;
    first.fire('open', undefined);
    first.deliver({ type: 'session.ack' });
    mock.timers.tick(120_000);
    first.fire('close', undefined);
    mock.timers.tick(500);
    assert.equal(opened.length, 2, 'a long-lived connection should retry at once');
  });
});

describe('a message past the relay’s limit', () => {
  test('is not handed to the socket, because that closes it', async () => {
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();
    const ws = opened[0]!;
    ws.fire('open', undefined);
    ws.deliver({ type: 'session.ack' });
    const before = ws.sent.length;

    t.send({ type: 'screen.snapshot', ts: 1, doc: 'x'.repeat(AGENT_MAX_MESSAGE_BYTES) });

    const huge = ws.sent.slice(before).filter((s) => s.length > AGENT_MAX_MESSAGE_BYTES);
    assert.deepEqual(huge, [], 'it sent the message that gets the connection dropped');
  });

  test('says so, rather than leaving a gap nobody can explain', async () => {
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();
    const ws = opened[0]!;
    ws.fire('open', undefined);
    ws.deliver({ type: 'session.ack' });
    const before = ws.sent.length;

    t.send({ type: 'screen.snapshot', ts: 1, doc: 'x'.repeat(AGENT_MAX_MESSAGE_BYTES) });

    const marks = ws.sent.slice(before).map((s) => JSON.parse(s) as { type: string; name?: string });
    assert.ok(
      marks.some((m) => m.type === 'mark.custom' && /too large/i.test(m.name ?? '')),
      `nothing said the frame was dropped: ${JSON.stringify(marks)}`,
    );
  });

  test('an ordinary message still goes', async () => {
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();
    const ws = opened[0]!;
    ws.fire('open', undefined);
    ws.deliver({ type: 'session.ack' });
    const before = ws.sent.length;
    t.send({ type: 'console.message', ts: 1, level: 'log', args: [] });
    assert.equal(ws.sent.length, before + 1);
  });
});
