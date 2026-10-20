/**
 * HAR 1.2 export from captured entries (DevTools "Save all as HAR").
 *
 * Sizes in HAR are bytes. A JavaScript string's `length` is UTF-16 code
 * units, so using it understates anything that is not plain ASCII — a Korean
 * JSON body by roughly a third — and for a base64 body it reports the
 * encoding's length rather than the payload's.
 */
import type { NetworkEntry } from '../../state/session-data';
import { timelineOf } from './timing';
import { downloadText } from '../../devtools-ui/download';

/**
 * A HAR of these entries, bodies and all.
 *
 * Asynchronous because a recorded run keeps its larger bodies in the relay's
 * blob store rather than in the event. Exporting without them would hand
 * someone a file that looks complete and is not, so the export waits.
 */
export async function toHar(entries: NetworkEntry[], meta: { title: string; url: string; sessionId: string }): Promise<unknown> {
  const stored = await fetchStoredBodies(entries, meta.sessionId);
  return {
    log: {
      version: '1.2',
      creator: { name: 'BXConsole', version: '0.1.0' },
      pages: [{ startedDateTime: new Date(entries[0]?.request.ts ?? Date.now()).toISOString(), id: 'page_1', title: meta.title || meta.url, pageTimings: {} }],
      entries: entries.map((e) => toHarEntry(e, stored)),
    },
  };
}

/** The body as HAR wants it, from the event or from the store. */
function harBodyText(e: NetworkEntry, stored: Map<string, string>): Record<string, unknown> {
  const res = e.response;
  if (res?.body != null) return { text: res.body, ...(res.bodyEncoding === 'base64' ? { encoding: 'base64' } : {}) };
  const held = res?.bodyRef ? stored.get(res.bodyRef) : undefined;
  return held === undefined ? {} : { text: held };
}

/** The bodies that live in the store, by hash, fetched once each. */
async function fetchStoredBodies(entries: NetworkEntry[], sessionId: string): Promise<Map<string, string>> {
  const refs = new Set<string>();
  for (const e of entries) {
    if (e.response?.body == null && e.response?.bodyRef) refs.add(e.response.bodyRef);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...refs].map(async (sha) => {
      try {
        const res = await fetch(`/body/${sessionId}/${sha}`);
        if (res.ok) out.set(sha, await res.text());
      } catch {
        /* the sweep took it: the entry goes out without a body, as it would have anyway */
      }
    }),
  );
  return out;
}

function toHarEntry(e: NetworkEntry, stored: Map<string, string>) {
  const t = timelineOf(e);
  const total = t.end === null ? -1 : t.end - t.start;
  const wait = t.phases.find((p) => p.id === 'waiting');
  const download = t.phases.find((p) => p.id === 'download');
  const url = new URL(e.request.url, 'http://x');
  const status = e.response?.status ?? e.resource?.responseStatus ?? 0;
  return {
    pageref: 'page_1',
    startedDateTime: new Date(t.start).toISOString(),
    time: total,
    request: {
      method: e.request.method,
      url: e.request.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: toHeaders(e.request.headers),
      queryString: Array.from(url.searchParams.entries()).map(([name, value]) => ({ name, value })),
      ...(e.request.body ? { postData: { mimeType: e.request.headers['content-type'] ?? '', text: e.request.body } } : {}),
      headersSize: -1,
      bodySize: byteLength(e.request.body),
    },
    response: {
      status,
      statusText: e.response?.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: toHeaders(e.response?.headers ?? {}),
      content: {
        size: e.resource?.decodedBodySize ?? e.response?.bodyBytes ?? byteLength(e.response?.body, e.response?.bodyEncoding),
        mimeType: e.response?.mimeType ?? '',
        ...harBodyText(e, stored),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: e.resource?.transferSize ?? e.response?.encodedLength ?? -1,
      ...(e.failed ? { _error: e.failed.error } : {}),
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: 0,
      wait: wait ? wait.end - wait.start : Math.max(0, total),
      receive: download ? download.end - download.start : 0,
      ssl: -1,
    },
    ...(e.resource ? { _resourceType: e.resource.initiatorType } : { _resourceType: e.request.kind }),
    ...(e.request.stack ? { _initiator: { type: 'script', stack: e.request.stack } } : {}),
    ...(e.frames?.length
      ? { _webSocketMessages: e.frames.map((f) => ({ type: f.direction === 'sent' ? 'send' : 'receive', time: f.ts / 1000, opcode: f.opcode === 'text' ? 1 : 2, data: f.data })) }
      : {}),
  };
}

/** Bytes a body occupies on the wire, from the text we hold. */
function byteLength(text: string | null | undefined, encoding?: 'base64' | 'text' | undefined): number {
  if (!text) return 0;
  if (encoding === 'base64') {
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(text).length;
}

function toHeaders(h: Record<string, string>) {
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}

export function downloadJson(data: unknown, filename: string): void {
  downloadText(JSON.stringify(data, null, 2), filename, 'application/json');
}
