/**
 * DevTools filter box syntax, the observable subset:
 *
 *   text            substring of the URL (case-insensitive)
 *   /regex/         regular expression on the URL
 *   -term           negate any term
 *   domain:x.com    wildcards allowed (*.example.com)
 *   method:POST     status-code:404   mime-type:application/json
 *   larger-than:1k  (k / M suffix)    scheme:https     url:part
 *   resource-type:fetch|xhr|doc|css|js|font|img|media|manifest|ws|wasm|other
 *   has-response-header:content-type   is:running
 *
 * Terms are ANDed. `invert` negates the whole result.
 */
import type { NetworkEntry } from '../../state/session-data';
import { classify, sizeLabel } from './classify';

export type Predicate = (e: NetworkEntry) => boolean;

export function compileFilter(text: string, invert: boolean): Predicate {
  const terms = text.trim().split(/\s+/).filter(Boolean).map(compileTerm);
  if (!terms.length) return () => true;
  const all: Predicate = (e) => terms.every((t) => t(e));
  return invert ? (e) => !all(e) : all;
}

function compileTerm(raw: string): Predicate {
  const negate = raw.startsWith('-') && raw.length > 1;
  const term = negate ? raw.slice(1) : raw;
  const p = compilePositive(term);
  return negate ? (e) => !p(e) : p;
}

function compilePositive(term: string): Predicate {
  // `/regex/` only, with no trailing flags — the syntax Chrome's filter box
  // takes, and the one documented above. Accepting flags here meant a plain
  // path whose last segment happened to be flag letters was silently read as
  // a regex: `/assets/im` became /assets/ with ignoreCase+multiline and
  // matched far more than the user typed.
  const re = /^\/(.+)\/$/.exec(term);
  if (re) {
    try {
      const rx = new RegExp(re[1]!);
      return (e) => rx.test(e.request.url);
    } catch {
      /* not a valid regex after all: fall through to substring */
    }
  }

  const idx = term.indexOf(':');
  if (idx > 0) {
    const key = term.slice(0, idx).toLowerCase();
    const value = term.slice(idx + 1);
    const prop = compileProperty(key, value);
    if (prop) return prop;
  }

  const lower = term.toLowerCase();
  return (e) => e.request.url.toLowerCase().includes(lower);
}

function compileProperty(key: string, value: string): Predicate | null {
  const lower = value.toLowerCase();
  switch (key) {
    case 'domain': {
      const rx = new RegExp(`^${lower.split('*').map(escape).join('.*')}$`);
      return (e) => rx.test(hostOf(e.request.url).toLowerCase());
    }
    case 'method':
      return (e) => e.request.method.toLowerCase() === lower;
    case 'status-code':
      return (e) => String(e.response?.status ?? e.resource?.responseStatus ?? '') === value;
    case 'mime-type':
      return (e) => (e.response?.mimeType ?? '').toLowerCase() === lower;
    case 'larger-than': {
      const bytes = parseSize(lower);
      return bytes === null ? null : (e) => sizeLabel(e).bytes > bytes;
    }
    case 'resource-type':
      return (e) => classify(e) === lower || (lower === 'websocket' && classify(e) === 'ws');
    case 'scheme':
      return (e) => e.request.url.toLowerCase().startsWith(`${lower}:`);
    case 'url':
      return (e) => e.request.url.toLowerCase().includes(lower);
    case 'has-response-header':
      return (e) => Boolean(e.response?.headers[lower]);
    case 'is':
      if (lower === 'running') return (e) => !e.finished && !e.failed && !e.resource;
      return null;
    default:
      return null;
  }
}

function parseSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'k' ? n * 1024 : m[2] === 'm' ? n * 1024 * 1024 : n;
}

/**
 * The host part of a url, or `fallback` when it is not a url at all.
 *
 * The fallback is the caller's: a filter wants nothing to match on, while a
 * tree would rather show the raw string than an unlabelled node.
 */
export function hostOf(url: string, fallback = ''): string {
  try {
    return new URL(url).host;
  } catch {
    return fallback;
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
