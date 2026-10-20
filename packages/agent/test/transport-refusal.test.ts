/**
 * What the transport does when the relay will not take the run.
 *
 * The transport's whole job is to come back: a blind XSS payload fires in a
 * browser nobody can reach, so a dropped connection has to be retried or the
 * run is simply lost. That makes a refusal the one thing it must not retry.
 * A payload with no project to go into would otherwise knock every few
 * seconds for as long as the page is open, from every window the run spread
 * to, while the operator sees nothing anywhere saying why no session
 * appeared.
 */
import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionHello } from '@bxconsole/protocol';

/** Every socket the transport has opened, in order. */
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
  /** As the relay would: a message arrives on this socket. */
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

/**
 * Load the transport with the fake in place.
 *
 * It captures `window.WebSocket` when the module is evaluated — before
 * hooks/network.ts replaces the page's — so the stand-in has to be on the
 * global first, and the module has to be imported fresh each time.
 */
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

describe('a refused run', () => {
  test('stops, where an ordinary close comes back', async () => {
    const Transport = await freshTransport();

    // An ordinary close is retried: that is the behaviour being protected.
    const ordinary = new Transport('ws://relay.test/ws/agent', hello);
    ordinary.connect();
    assert.equal(opened.length, 1);
    opened[0]!.close();
    mock.timers.tick(10_000);
    assert.equal(opened.length, 2, 'a dropped connection must be retried');

    /*
     * A refusal is not — and the sequence here is the relay's: it sends the
     * refusal and then closes the socket. Testing the refusal without the
     * close would pass however the refusal were handled, because an
     * unclosed socket never reaches the reconnect either.
     */
    const refused = new Transport('ws://relay.test/ws/agent', hello);
    refused.connect();
    const before = opened.length;
    const ws = opened[before - 1]!;
    ws.fire('open', undefined);
    ws.deliver({ type: 'session.refused', reason: 'no project key' });
    ws.fire('close', undefined);
    mock.timers.tick(60_000);
    assert.equal(opened.length, before, 'it knocked again after being told not to');
  });

  test('the socket is closed rather than left open doing nothing', async () => {
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();
    const ws = opened[0]!;
    ws.fire('open', undefined);
    ws.deliver({ type: 'session.refused', reason: 'no project key' });
    assert.equal(ws.closed, true);
  });

  test('connect() does not undo it', async () => {
    /*
     * `connect()` clears the flag that an ordinary close sets, which is
     * right for that one and would be wrong here: a refusal is about the
     * payload, so asking again is answered the same way forever.
     */
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();
    opened[0]!.fire('open', undefined);
    opened[0]!.deliver({ type: 'session.refused', reason: 'no project key' });
    const before = opened.length;

    t.connect();
    mock.timers.tick(60_000);
    assert.equal(opened.length, before);
  });

  test('nothing is sent afterwards, whatever the page goes on doing', async () => {
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    t.connect();
    const ws = opened[0]!;
    ws.fire('open', undefined);
    const afterHello = ws.sent.length;
    ws.deliver({ type: 'session.refused', reason: 'no project key' });

    t.send({ type: 'console.message', ts: 1, level: 'log', args: [] });
    // An ack would normally make the queue flush. The run is over.
    ws.deliver({ type: 'session.ack', sessionId: 'sess01', tabId: 'tabA' });
    t.send({ type: 'console.message', ts: 2, level: 'log', args: [] });
    mock.timers.tick(60_000);
    assert.equal(ws.sent.length, afterHello, `sent ${JSON.stringify(ws.sent.slice(afterHello))}`);
    assert.equal(opened.length, 1, 'and it did not open another socket to send them on');
  });

  test('the refusal still reaches the handlers, so the reason is not swallowed', async () => {
    const Transport = await freshTransport();
    const t = new Transport('ws://relay.test/ws/agent', hello);
    const seen: unknown[] = [];
    t.onMessage((msg) => seen.push(msg));
    t.connect();
    opened[0]!.fire('open', undefined);
    opened[0]!.deliver({ type: 'session.refused', reason: 'no project key' });
    assert.deepEqual(seen, [{ type: 'session.refused', reason: 'no project key' }]);
  });
});
