/**
 * WebSocket transport with reconnect + offline queue.
 *
 * The hooks call `send()` from the very first tick, before the socket is up,
 * so messages buffer until `session.ack` arrives. Reconnects re-send hello
 * and flush the queue, so a relay restart does not lose events.
 */
import type { AgentToServer, ServerToAgent, SessionHello } from '@bxconsole/protocol';
import { PROTOCOL_VERSION } from '@bxconsole/protocol';

type MessageHandler = (msg: ServerToAgent) => void;

// Captured at module evaluation, before hooks/network.ts replaces window.WebSocket.
const NativeWebSocket = window.WebSocket;

const MAX_QUEUE = 2000;
/** Bytes already handed to the socket before we start shedding screen traffic. */
const MAX_BUFFERED = 1 << 20;

/** Screen ops can be dropped; the next snapshot replaces them anyway. */
function isExpendable(msg: AgentToServer): boolean {
  return msg.type === 'screen.mutations' || msg.type === 'screen.cursor';
}
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000];

export class Transport {
  private ws: WebSocket | null = null;
  private ready = false;
  private queue: AgentToServer[] = [];
  private handlers: MessageHandler[] = [];
  private attempt = 0;
  private closedByUser = false;
  /**
   * The relay said this run is not wanted. One way, and not cleared by
   * `connect()`: a refusal is about the payload, so coming back round to
   * ask again would be answered the same way, forever.
   */
  private refused = false;

  constructor(
    private readonly url: string,
    private readonly hello: () => SessionHello,
  ) {}

  connect(): void {
    if (this.refused) return;
    this.closedByUser = false;
    this.open();
  }

  /** events thrown away while the link could not keep up */
  private dropped = 0;

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  send(msg: AgentToServer): void {
    if (this.ready && this.ws?.readyState === NativeWebSocket.OPEN) {
      // The browser buffers without limit, inside the page being debugged, so
      // a slow link plus a chatty page would grow the page's memory until the
      // tab dies. Past the mark, the expendable traffic is dropped: screen ops
      // are a continuous stream that the next snapshot supersedes, while
      // console, network and errors are what the session is for.
      if (this.ws.bufferedAmount > MAX_BUFFERED && isExpendable(msg)) {
        this.dropped++;
        return;
      }
      this.ws.send(JSON.stringify(msg));
      this.reportDrops();
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(msg);
  }

  /**
   * Say so once the link recovers. A gap the console cannot see is worse than
   * the gap itself: the mark lands on the History timeline where it happened.
   */
  private reportDrops(): void {
    if (this.dropped === 0 || !this.ws) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) return;
    const n = this.dropped;
    this.dropped = 0;
    this.ws.send(
      JSON.stringify({
        type: 'mark.custom',
        ts: Date.now(),
        name: 'dropped events',
        data: { t: 'number', v: n },
      } satisfies AgentToServer),
    );
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new NativeWebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ type: 'session.hello', v: PROTOCOL_VERSION, hello: this.hello() }));
    });

    ws.addEventListener('message', (ev) => {
      let msg: ServerToAgent;
      try {
        msg = JSON.parse(String(ev.data)) as ServerToAgent;
      } catch {
        return;
      }
      if (msg.type === 'session.ack') {
        this.ready = true;
        this.flush();
      }
      if (msg.type === 'session.refused') {
        /*
         * Stop, rather than close and come back.
         *
         * A refusal is about the payload, not the connection — no project to
         * put the run in — so reconnecting asks the same question and gets
         * the same answer. Left to the ordinary close handling this would
         * knock every few seconds for as long as the page is open, from
         * every window the run spread to.
         *
         * The queue is dropped with it. Nothing is going to be sent, and
         * holding the events would only grow until the cap threw them away
         * one at a time.
         */
        this.refused = true;
        this.ready = false;
        this.queue = [];
        this.ws?.close();
      }
      for (const h of this.handlers) h(msg);
    });

    ws.addEventListener('close', () => {
      this.ready = false;
      this.ws = null;
      if (!this.closedByUser && !this.refused) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' follows; nothing to do here
    });
  }

  private flush(): void {
    if (!this.ws) return;
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 10000;
    this.attempt += 1;
    setTimeout(() => this.open(), delay);
  }
}
