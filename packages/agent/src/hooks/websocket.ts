/**
 * WebSocket interception -> one `network.request` (kind websocket) per
 * socket, `network.response` 101 on open, `network.wsFrame` per message in
 * either direction, `network.wsClosed` + `network.finished` on close.
 *
 * The agent's own relay socket uses the native constructor captured in
 * transport.ts, so it never shows up here.
 */
import type { AgentConfig } from '../config';
import { captureStack } from '../stack';
import type { Transport } from '../transport';
import { newRequestId } from './network';

const MAX_FRAME_TEXT = 8 * 1024;

export function installWebSocketHook(transport: Transport, config: AgentConfig): void {
  const Native = window.WebSocket;

  const Patched = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const requestId = newRequestId();
    const start = performance.now();
    const stack = captureStack(config);
    const href = (() => {
      try {
        return new URL(String(url), location.href).href;
      } catch {
        return String(url);
      }
    })();

    transport.send({
      type: 'network.request',
      ts: Date.now(),
      requestId,
      kind: 'websocket',
      method: 'GET',
      url: href,
      headers: protocols ? { 'sec-websocket-protocol': Array.isArray(protocols) ? protocols.join(', ') : protocols } : {},
      ...(stack ? { stack } : {}),
    });

    ws.addEventListener('open', () => {
      transport.send({
        type: 'network.response',
        ts: Date.now(),
        requestId,
        status: 101,
        statusText: 'Switching Protocols',
        headers: ws.protocol ? { 'sec-websocket-protocol': ws.protocol } : {},
        waitMs: performance.now() - start,
      });
    });
    ws.addEventListener('message', (ev) => {
      transport.send({ type: 'network.wsFrame', ts: Date.now(), requestId, direction: 'received', ...describe(ev.data) });
    });
    ws.addEventListener('close', (ev) => {
      transport.send({ type: 'network.wsClosed', ts: Date.now(), requestId, code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      transport.send({ type: 'network.finished', ts: Date.now(), requestId, durationMs: performance.now() - start });
    });
    ws.addEventListener('error', () => {
      transport.send({ type: 'network.failed', ts: Date.now(), requestId, error: 'WebSocket error' });
    });

    const originalSend = ws.send.bind(ws);
    ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      transport.send({ type: 'network.wsFrame', ts: Date.now(), requestId, direction: 'sent', ...describe(data) });
      return originalSend(data);
    };
    return ws;
  } as unknown as typeof WebSocket;

  // Keep statics (CONNECTING/OPEN/…) and instanceof working.
  Patched.prototype = Native.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
}

function describe(data: unknown): { opcode: 'text' | 'binary'; data: string; length: number; truncated?: boolean } {
  if (typeof data === 'string') {
    return data.length > MAX_FRAME_TEXT
      ? { opcode: 'text', data: data.slice(0, MAX_FRAME_TEXT), length: data.length, truncated: true }
      : { opcode: 'text', data, length: data.length };
  }
  if (data instanceof Blob) return { opcode: 'binary', data: `[Blob ${data.size} bytes]`, length: data.size };
  if (data instanceof ArrayBuffer) return { opcode: 'binary', data: `[ArrayBuffer ${data.byteLength} bytes]`, length: data.byteLength };
  if (ArrayBuffer.isView(data)) return { opcode: 'binary', data: `[${data.constructor.name} ${data.byteLength} bytes]`, length: data.byteLength };
  return { opcode: 'binary', data: String(data), length: 0 };
}
