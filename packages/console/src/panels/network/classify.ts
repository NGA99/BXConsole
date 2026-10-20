/** Resource type classification + the Type/Size/Time column text, as DevTools shows them. */
import type { NetworkEntry } from '../../state/session-data';

export type ResourceType =
  | 'fetch' | 'xhr' | 'doc' | 'css' | 'js' | 'font' | 'img' | 'media' | 'manifest' | 'ws' | 'eventsource' | 'wasm' | 'other';

/**
 * A request that stays open and delivers frames instead of a body.
 *
 * WebSockets and EventSource both do this, and every place that treated the
 * first specially — the pending-row clock, the frames tab, both body readers
 * — meant this rather than "is a websocket". Server-sent events arrived later
 * and inherited none of it until they were given this name.
 */
export function streamsFrames(entry: NetworkEntry): boolean {
  return entry.request.kind === 'websocket' || entry.request.kind === 'eventsource';
}

export interface TypeChip {
  id: 'all' | ResourceType | 'fetchxhr';
  label: string;
  matches: (t: ResourceType) => boolean;
}

export const TYPE_CHIPS: TypeChip[] = [
  { id: 'all', label: 'All', matches: () => true },
  { id: 'fetchxhr', label: 'Fetch/XHR', matches: (t) => t === 'fetch' || t === 'xhr' },
  { id: 'doc', label: 'Doc', matches: (t) => t === 'doc' },
  { id: 'css', label: 'CSS', matches: (t) => t === 'css' },
  { id: 'js', label: 'JS', matches: (t) => t === 'js' },
  { id: 'font', label: 'Font', matches: (t) => t === 'font' },
  { id: 'img', label: 'Img', matches: (t) => t === 'img' },
  { id: 'media', label: 'Media', matches: (t) => t === 'media' },
  { id: 'manifest', label: 'Manifest', matches: (t) => t === 'manifest' },
  { id: 'ws', label: 'Socket', matches: (t) => t === 'ws' },
  { id: 'eventsource', label: 'EventSource', matches: (t) => t === 'eventsource' },
  { id: 'wasm', label: 'Wasm', matches: (t) => t === 'wasm' },
  { id: 'other', label: 'Other', matches: (t) => t === 'other' },
];

const EXT: Record<string, ResourceType> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js',
  css: 'css',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img', ico: 'img', avif: 'img', bmp: 'img',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
  mp4: 'media', webm: 'media', mp3: 'media', ogg: 'media', wav: 'media', m4a: 'media',
  html: 'doc', htm: 'doc',
  json: 'fetch', webmanifest: 'manifest', wasm: 'wasm',
};

export function classify(entry: NetworkEntry): ResourceType {
  if (entry.request.kind === 'fetch') return 'fetch';
  if (entry.request.kind === 'xhr') return 'xhr';
  if (entry.request.kind === 'websocket') return 'ws';
  if (entry.request.kind === 'eventsource') return 'eventsource';
  if (entry.request.kind === 'beacon') return 'other';

  const r = entry.resource;
  const ext = extensionOf(entry.request.url);
  switch (r?.initiatorType) {
    case 'script':
      return 'js';
    case 'css':
      return ext && EXT[ext] === 'font' ? 'font' : 'img'; // url() from a stylesheet
    case 'link':
      return ext && EXT[ext] ? EXT[ext]! : 'css';
    case 'img':
    case 'image':
    case 'input':
      return 'img';
    case 'video':
    case 'audio':
    case 'track':
      return 'media';
    case 'iframe':
    case 'frame':
    case 'navigation':
      return 'doc';
    case 'font':
      return 'font';
  }
  return (ext ? EXT[ext] : undefined) ?? 'other';
}

/** The Type column: mime subtype for fetch/xhr, resource class for the rest. */
export function typeLabel(entry: NetworkEntry): string {
  const t = classify(entry);
  if (t === 'fetch' || t === 'xhr') {
    const mime = entry.response?.mimeType;
    if (mime) {
      const sub = mime.split('/')[1] ?? mime;
      return sub.replace(/^x-/, '').replace('javascript', 'script');
    }
    return t;
  }
  switch (t) {
    case 'js':
      return 'script';
    case 'css':
      return 'stylesheet';
    case 'doc':
      return 'document';
    case 'img':
      return extensionOf(entry.request.url) ?? 'image';
    default:
      return t;
  }
}

export function extensionOf(url: string): string | undefined {
  try {
    const path = new URL(url, 'http://x').pathname;
    const m = /\.([a-z0-9]+)$/i.exec(path);
    return m?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

export function nameOf(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return (last ?? u.host) + u.search;
  } catch {
    return url;
  }
}

/**
 * What the page could see. Cross-origin resources without Timing-Allow-Origin
 * expose no status (0) to scripts, and no-cors fetches get opaque responses:
 * neither means the request failed, so they are labelled, not marked red.
 */
export function statusLabel(entry: NetworkEntry): string {
  if (entry.failed) return '(failed)';
  const res = entry.response;
  if (res) {
    if (res.status === 0) return res.responseType === 'opaque' || res.responseType === 'opaqueredirect' ? '(opaque)' : '(failed)';
    return String(res.status);
  }
  if (entry.resource) {
    const rs = entry.resource.responseStatus;
    return rs && rs > 0 ? String(rs) : '—';
  }
  /*
   * A beacon has no response to wait for and never will: the browser takes
   * the payload and the page is told only whether it was taken. "(pending)"
   * was a row that looked stuck forever.
   */
  if (entry.request.kind === 'beacon') return entry.finished ? '(queued)' : '(pending)';
  return '(pending)';
}

export function statusTitle(entry: NetworkEntry): string | undefined {
  if (entry.failed) return entry.failed.error;
  if (entry.response?.status === 0) return 'no-cors request: the status and body are not visible to page scripts';
  if (entry.resource && !(entry.resource.responseStatus && entry.resource.responseStatus > 0)) {
    return 'Cross-origin resource: status and size are not exposed to page scripts unless the server sends Timing-Allow-Origin';
  }
  if (entry.request.kind === 'beacon' && entry.finished) {
    return 'The browser accepted this beacon for sending. A beacon has no response, so there is nothing further to report.';
  }
  return undefined;
}

export function sizeLabel(entry: NetworkEntry): { text: string; bytes: number } {
  if (entry.resource) {
    const r = entry.resource;
    if (r.transferSize === 0 && r.decodedBodySize > 0) return { text: '(cache)', bytes: 0 };
    if (r.transferSize === 0 && r.decodedBodySize === 0) return { text: '—', bytes: 0 }; // cross-origin without TAO, or truly empty
    return { text: formatBytes(r.transferSize), bytes: r.transferSize };
  }
  const n = entry.response?.encodedLength ?? entry.response?.body?.length;
  if (n === undefined) return { text: entry.failed ? '0 B' : '', bytes: 0 };
  return { text: formatBytes(n), bytes: n };
}

export function durationOf(entry: NetworkEntry): number | undefined {
  return entry.finished?.durationMs ?? entry.resource?.duration;
}

export function timeLabel(entry: NetworkEntry): string {
  const d = durationOf(entry);
  if (d === undefined) return entry.failed ? '—' : 'Pending';
  return formatMs(d);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}
