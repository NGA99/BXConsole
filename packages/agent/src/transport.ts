/**
 * WebSocket transport with reconnect + offline queue.
 *
 * The hooks call `send()` from the very first tick, before the socket is up,
 * so messages buffer until `session.ack` arrives. Reconnects re-send hello
 * and flush the queue, so a relay restart does not lose events.
 */
import type { AgentToServer, ServerToAgent, SessionHello } from '@bxconsole/protocol';
import { AGENT_MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '@bxconsole/protocol';

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

/**
 * How long a connection has to last before it counts as one that worked.
 *
 * The backoff used to reset the moment a socket opened, and opening is not
 * the same as working: the relay drops a connection as soon as a message
 * arrives past its size limit, so the handshake succeeds, the session is
 * acknowledged, and the link dies anyway — every time, identically. With the
 * counter reset on open, that is a reconnection every 500ms for as long as
 * the page is open, from a browser nobody can reach. Measured against a real
 * relay before this: seventeen in thirteen seconds.
 *
 * Longer than the longest backoff, so a connection that merely survived one
 * wait does not count as healthy.
 */
const STEADY_MS = 30_000;

/**
 * Whether a message would be refused by the relay for its size.
 *
 * Cheap in the two cases that matter and exact in the narrow band between
 * them: a string can never encode to fewer bytes than it has code units, and
 * never to more than three times as many, so only a length inside that range
 * has to be measured — and measuring means copying the whole string, which
 * is the thing to avoid when it may be eight megabytes.
 */
function tooBigForRelay(raw: string): boolean {
  if (raw.length > AGENT_MAX_MESSAGE_BYTES) return true;
  if (raw.length <= AGENT_MAX_MESSAGE_BYTES / 3) return false;
  return new TextEncoder().encode(raw).length > AGENT_MAX_MESSAGE_BYTES;
}

export class Transport {
  private ws: WebSocket | null = null;
  private ready = false;
  private queue: AgentToServer[] = [];
  private handlers: MessageHandler[] = [];
  private attempt = 0;
  /** when the live socket opened, for deciding whether it ever worked */
  private openedAt = 0;
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
    /*
     * Measured before anything else, including the queue: a message the relay
     * will refuse is not worth keeping either. Handing it over closes the
     * connection, and the agent comes straight back and does it again —
     * which is how a single page too large to mirror turned into a permanent
     * reconnect loop against the relay.
     */
    const raw = JSON.stringify(msg);
    if (tooBigForRelay(raw)) return this.reportTooBig(msg.type, raw.length);

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
      this.ws.send(raw);
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
   * Say which frame was never sent, on the timeline where it happened.
   *
   * There is no message for "this page is too big to mirror", and a mark is
   * one the console already draws — so the Screen pane staying empty has
   * something next to it in History saying why, rather than being a gap the
   * operator is left to guess at. Sent at once rather than counted up: a
   * snapshot that is too large tends to be the only thing the page was
   * trying to send, so there may be no later traffic to carry the news.
   */
  private reportTooBig(type: string, chars: number): void {
    if (!this.ready || this.ws?.readyState !== NativeWebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'mark.custom',
        ts: Date.now(),
        name: `${type} was too large to send`,
        data: { t: 'number', v: chars },
      } satisfies AgentToServer),
    );
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
      this.openedAt = Date.now();
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
      // Reset here rather than on open: a connection counts as one that
      // worked only once it has lasted, and this is where that is known.
      if (this.openedAt && Date.now() - this.openedAt >= STEADY_MS) this.attempt = 0;
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
