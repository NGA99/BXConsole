/**
 * fetch + XMLHttpRequest interception -> network.request / response /
 * finished / failed.
 *
 * Bodies are captured when `config.captureBodies` is on. Response bodies are
 * read from a clone so the page's own consumer is untouched. Binary bodies
 * are shipped as base64 up to `maxBodyLength`.
 *
 * TODO: XHR upload progress, ReadableStream responses (currently waits for
 *       full body), sendBeacon, WebSocket frames.
 */
import { isTextualMime, type NetworkKind } from '@bxconsole/protocol';
import type { AgentConfig } from '../config';
import { captureStack } from '../stack';
import type { Transport } from '../transport';

let nextRequestId = 1;
import { scopedId } from '../ids';

export const newRequestId = (): string => scopedId(`r${nextRequestId++}`);

/** The page's original fetch, captured before patching: used by the agent itself so its own requests stay out of the Network tab. */
export const rawFetch: typeof fetch = window.fetch.bind(window);

/** Console-controlled behaviour (DevTools "Block request URL", "Disable cache"). */
export const networkSettings = { blocked: [] as string[], disableCache: false };

export function configureNetwork(patch: { blocked?: string[]; disableCache?: boolean }): void {
  if (patch.blocked) networkSettings.blocked = patch.blocked;
  if (patch.disableCache !== undefined) networkSettings.disableCache = patch.disableCache;
}

export function isBlocked(url: string): boolean {
  return networkSettings.blocked.some((p) => p && url.includes(p));
}

export const BLOCKED_ERROR = 'net::ERR_BLOCKED_BY_CLIENT';

export function installNetworkHook(transport: Transport, config: AgentConfig): void {
  patchFetch(transport, config);
  patchXhr(transport, config);
}

// --------------------------------------------------------------------------- fetch

function patchFetch(transport: Transport, config: AgentConfig): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestId = newRequestId();
    const start = performance.now();
    const stack = captureStack(config);
    // Describe the call from what the page passed, without building a Request
    // from it: constructing (and cloning) one marks a ReadableStream body used,
    // so a streaming upload would fail with "body already used" — an error the
    // page would never have seen without the agent.
    const described = describeRequest(input, init);

    transport.send({
      type: 'network.request',
      ts: Date.now(),
      requestId,
      kind: 'fetch',
      method: described.method,
      url: described.url,
      headers: described.headers,
      ...(stack ? { stack } : {}),
      ...(config.captureBodies ? truncate(described.body, config) : {}),
    });

    if (isBlocked(described.url)) {
      transport.send({ type: 'network.failed', ts: Date.now(), requestId, error: BLOCKED_ERROR });
      throw new TypeError('Failed to fetch');
    }

    try {
      const effectiveInit = networkSettings.disableCache ? { ...init, cache: 'no-store' as RequestCache } : init;
      const response = await originalFetch(input, effectiveInit);
      const waitMs = performance.now() - start; // fetch resolves when headers arrive
      void reportResponse(transport, config, requestId, response, start, waitMs);
      return response;
    } catch (err) {
      transport.send({
        type: 'network.failed',
        ts: Date.now(),
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

async function reportResponse(
  transport: Transport,
  config: AgentConfig,
  requestId: string,
  response: Response,
  start: number,
  waitMs: number,
): Promise<void> {
  const headers = headersToObject(response.headers);
  // Taken before reading the body: including the agent's own decode time made
  // the Network tab's duration wrong, not merely slow.
  const durationMs = performance.now() - start;
  // Clone here, not at the call site: a clone is only made when its body is
  // actually going to be read, so a response nobody captures is not tee'd and
  // the page keeps its own backpressure.
  const body = config.captureBodies ? await readResponseBody(response.clone(), config) : {};
  transport.send({
    type: 'network.response',
    ts: Date.now(),
    requestId,
    status: response.status,
    statusText: response.statusText,
    headers,
    mimeType: headers['content-type']?.split(';')[0]?.trim(),
    waitMs,
    responseType: response.type,
    ...body,
  });
  transport.send({ type: 'network.finished', ts: Date.now(), requestId, durationMs });
}

// --------------------------------------------------------------------------- XHR

function patchXhr(transport: Transport, config: AgentConfig): void {
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetHeader = proto.setRequestHeader;

  interface Tracked {
    requestId: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    start: number;
    headersAt?: number;
    stack?: string;
  }
  const tracked = new WeakMap<XMLHttpRequest, Tracked>();

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const stack = captureStack(config);
    tracked.set(this, {
      requestId: newRequestId(),
      method,
      url: new URL(String(url), location.href).href,
      headers: {},
      start: 0,
      ...(stack ? { stack } : {}),
    });
    return (originalOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof proto.open;

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const t = tracked.get(this);
    if (t) t.headers[name.toLowerCase()] = value;
    return originalSetHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const t = tracked.get(this);
    if (t) {
      t.start = performance.now();
      if (networkSettings.disableCache) {
        try {
          originalSetHeader.call(this, 'Cache-Control', 'no-cache');
          originalSetHeader.call(this, 'Pragma', 'no-cache');
        } catch {
          /* already sent */
        }
      }
      transport.send({
        type: 'network.request',
        ts: Date.now(),
        requestId: t.requestId,
        kind: 'xhr' satisfies NetworkKind,
        method: t.method,
        url: t.url,
        headers: t.headers,
        ...(t.stack ? { stack: t.stack } : {}),
        ...(config.captureBodies ? truncate(bodyToString(body), config) : {}),
      });

      if (isBlocked(t.url)) {
        transport.send({ type: 'network.failed', ts: Date.now(), requestId: t.requestId, error: BLOCKED_ERROR });
        // Do not call through: blocking a request has to mean it never leaves,
        // or blocking a POST would still perform it while the UI says blocked.
        // The page sees readyState DONE with status 0, as with a network error.
        setTimeout(() => this.abort(), 0);
        return;
      }

      // One XHR object can be reused for many requests, and `open` replaces the
      // tracked request. Without taking these off again, a later response would
      // also be reported against every earlier requestId, and each reuse would
      // add another pair of listeners to the page's object.
      // Report at DONE, not at loadend. Between two listeners the browser runs
      // a microtask checkpoint, so a page that awaits its own loadend and then
      // calls open() again resets the object before a loadend listener here
      // gets to read it — the finished request would be reported as a network
      // error. At DONE the values are still the ones for this request.
      const onReadyStateChange = () => {
        if (this.readyState === XMLHttpRequest.HEADERS_RECEIVED && t.headersAt === undefined) {
          t.headersAt = performance.now();
          return;
        }
        if (this.readyState !== XMLHttpRequest.DONE) return;
        this.removeEventListener('readystatechange', onReadyStateChange);
        report();
      };
      this.addEventListener('readystatechange', onReadyStateChange);

      const report = () => {
        if (this.status === 0) {
          transport.send({ type: 'network.failed', ts: Date.now(), requestId: t.requestId, error: 'Network error' });
          return;
        }
        const headers = parseRawHeaders(this.getAllResponseHeaders());
        transport.send({
          type: 'network.response',
          ts: Date.now(),
          requestId: t.requestId,
          status: this.status,
          statusText: this.statusText,
          headers,
          mimeType: headers['content-type']?.split(';')[0]?.trim(),
          ...(t.headersAt !== undefined ? { waitMs: t.headersAt - t.start } : {}),
          ...(config.captureBodies ? truncate(xhrResponseToString(this), config) : {}),
        });
        transport.send({
          type: 'network.finished',
          ts: Date.now(),
          requestId: t.requestId,
          durationMs: performance.now() - t.start,
        });
      };
    }
    return originalSend.call(this, body);
  };
}

// --------------------------------------------------------------------------- helpers

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.trim().split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/**
 * What the page asked for, read off the arguments rather than reconstructed.
 *
 * The body is only taken when it is something we can look at for free. A
 * stream, a Blob or a Request's own body is left alone: reading it would
 * either consume what the page is about to send or make the call wait on us.
 */
function describeRequest(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string; headers: Record<string, string>; body: string | null } {
  const fromRequest = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  const url = fromRequest ? fromRequest.url : String(input);
  const method = (init?.method ?? fromRequest?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  try {
    const h = new Headers(init?.headers ?? fromRequest?.headers ?? undefined);
    h.forEach((v, k) => {
      headers[k] = v;
    });
  } catch {
    /* an init the Headers constructor refuses; report none */
  }
  return { url, method, headers, body: plainBody(init?.body) };
}

function plainBody(body: BodyInit | null | undefined): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((v, k) => parts.push(`${k}=${typeof v === 'string' ? v : '(file)'}`));
    return parts.join('&');
  }
  return null; // stream, Blob, ArrayBuffer, or a Request's own body
}

async function readResponseBody(res: Response, config: AgentConfig) {
  const type = res.headers.get('content-type') ?? '';
  try {
    if (isTextualMime(type)) {
      const { text, truncated } = await readCapped(res, config.maxBodyLength);
      return { body: text, ...(truncated ? { bodyTruncated: true } : {}) };
    }
    const buf = await res.arrayBuffer();
    // Only as many bytes as survive truncation are converted. Encoding a 50 MB
    // download in full to keep 64 KB of it froze the page for seconds.
    const keep = Math.min(buf.byteLength, Math.floor(config.maxBodyLength * 0.75));
    const body = arrayBufferToBase64(buf.slice(0, keep));
    return {
      body,
      ...(keep < buf.byteLength ? { bodyTruncated: true } : {}),
      bodyEncoding: 'base64' as const,
      encodedLength: buf.byteLength,
    };
  } catch {
    return { body: null };
  }
}

/**
 * Read at most `max` bytes and let the rest go.
 *
 * `res.text()` waits for the end of the body, so a server-sent-event stream or
 * a download the page consumes progressively would never be reported at all,
 * and the clone would hold the whole thing in the page's memory meanwhile.
 */
async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body) return { text: await res.text(), truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= max) {
        text = text.slice(0, max);
        truncated = true;
        break;
      }
    }
    text += decoder.decode();
  } finally {
    // Cancel either way: on the cap, and on an error partway through.
    void reader.cancel().catch(() => {});
  }
  return { text, truncated };
}


function truncate(text: string | null, config: AgentConfig): { body: string | null; bodyTruncated?: boolean } {
  if (text === null) return { body: null };
  if (text.length <= config.maxBodyLength) return { body: text };
  return { body: text.slice(0, config.maxBodyLength), bodyTruncated: true };
}

function bodyToString(body: Document | XMLHttpRequestBodyInit | null | undefined): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((v, k) => parts.push(`${k}=${typeof v === 'string' ? v : `[File ${v.name}]`}`));
    return parts.join('&');
  }
  if (body instanceof Blob) return `[Blob ${body.size} bytes]`;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[Binary ${body.byteLength} bytes]`;
  if (body instanceof Document) return new XMLSerializer().serializeToString(body);
  return String(body);
}

function xhrResponseToString(xhr: XMLHttpRequest): string | null {
  try {
    switch (xhr.responseType) {
      case '':
      case 'text':
        return xhr.responseText;
      case 'json':
        return JSON.stringify(xhr.response);
      case 'document':
        return xhr.response ? new XMLSerializer().serializeToString(xhr.response as Document) : null;
      case 'arraybuffer':
        return xhr.response ? arrayBufferToBase64(xhr.response as ArrayBuffer) : null;
      case 'blob':
        return `[Blob ${(xhr.response as Blob)?.size ?? 0} bytes]`;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // In chunks: one String.fromCharCode per byte builds a string the length of
  // the whole body before btoa ever sees it.
  const bytes = new Uint8Array(buf);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(parts.join(''));
}
