/**
 * The asset proxy's URL spelling, shared because three places have to agree
 * on it: the console builds these URLs into the mirror, the relay parses them,
 * and the relay writes more of them when it rewrites a stylesheet.
 *
 * Why the proxy exists at all: the console's browser must never load a
 * debugged page's images, stylesheets or fonts from their original URLs. The
 * page may be on a network the console cannot reach, behind a login the
 * console has no cookies for, or on a `localhost` address that means a
 * different machine — the last one does not fail, it silently shows the wrong
 * thing. The page fetches them instead and the relay passes the bytes on.
 */

/**
 * `/asset/{sessionId}/{base64url(url)}`, optionally `?tab=…&nofallback=1`.
 *
 * `tabId` names the window that should fetch it. A run can span windows on
 * different origins, and only the one the mirror is showing is guaranteed to
 * be able to read its own page's files — asking whichever window happened to
 * be active meant a cross-origin sibling was asked for bytes it could not see.
 *
 * `fallback: false` keeps the relay from redirecting the console's browser to
 * the original URL when it cannot produce the bytes. For one picture on a list
 * of recordings that is the right trade: the Sessions tab would otherwise
 * reach out to every origin it has ever recorded, every time it is drawn.
 */
export function assetPath(sessionId: string, url: string, opts?: { fallback?: boolean; tabId?: string }): string {
  const path = `/asset/${encodeURIComponent(sessionId)}/${base64UrlEncode(url)}`;
  const query: string[] = [];
  if (opts?.tabId) query.push(`tab=${encodeURIComponent(opts.tabId)}`);
  if (opts?.fallback === false) query.push('nofallback=1');
  return query.length ? `${path}?${query.join('&')}` : path;
}

export function decodeAssetUrl(encoded: string): string | null {
  try {
    const parsed = new URL(base64UrlDecode(encoded));
    // Only what a page can actually be asked to fetch. `file:` and friends
    // would be the relay lending out its own filesystem.
    if (!/^(https?|blob):$/i.test(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * The scheme a browser would act on, lowercased and with the colon, or null
 * when the value names none (a relative URL, or plain text).
 *
 * Not `value.split(':')[0]`, and not a `/^\s*scheme:/` regex: before a
 * browser looks at a URL it throws away leading C0 controls and spaces —
 * which `\s` does not cover, so a leading NUL hides the scheme from such a
 * regex — and it removes every tab, CR and LF *anywhere* in the string. That
 * last rule is what makes `java&#9;script:alert(1)` a working script URL, so
 * the stripping has to happen here too, before the match.
 *
 * It lives in the protocol package because two different packages have to
 * agree about it. They did not: the console grew a correct reader for the
 * links it draws while the rule below kept a regex that `\0javascript:` walks
 * straight past. Nothing escaped, because what the relay will actually fetch
 * is decided by decodeAssetUrl above and that allows three schemes — but one
 * of the two readings was wrong, and which one you got depended on where you
 * entered the code.
 */
export function urlScheme(raw: string): string | null {
  const normalized = raw.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
  return m ? `${m[1]!.toLowerCase()}:` : null;
}

/**
 * Schemes a page's markup can name that are not a file to go and fetch:
 * the inline ones carry their own bytes, the two scripting ones execute, and
 * the last two open an application rather than load anything.
 */
const NOT_WORTH_PROXYING = new Set(['data:', 'about:', 'javascript:', 'vbscript:', 'mailto:', 'tel:']);

/**
 * Whether a URL found in markup is worth proxying at all.
 *
 * A relative URL has no scheme and is the ordinary case, so it passes. This
 * is not the security boundary — decodeAssetUrl is, and it allows only http,
 * https and blob — it only decides what is worth asking for.
 */
export function isProxyableUrl(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.startsWith('#')) return false;
  const scheme = urlScheme(t);
  return scheme === null || !NOT_WORTH_PROXYING.has(scheme);
}

/**
 * Point a stylesheet's own references back at the proxy.
 *
 * A stylesheet served through `/asset/...` would otherwise resolve its `url()`
 * and `@import` against that path, which is not where those files live, so
 * every background image and webfont in it would 404. `toProxy` returns null
 * for anything that should be left exactly as written.
 */
export function rewriteCssUrls(css: string, baseUrl: string, toProxy: (absolute: string) => string | null): string {
  const one = (raw: string): string | null => {
    const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!isProxyableUrl(trimmed)) return null;
    try {
      return toProxy(new URL(trimmed, baseUrl).href);
    } catch {
      return null;
    }
  };
  return css
    .replace(/url\(\s*((?:'[^']*')|(?:"[^"]*")|(?:[^)\s]*))\s*\)/gi, (whole, raw: string) => {
      const next = one(raw);
      return next === null ? whole : `url("${next.replace(/"/g, '%22')}")`;
    })
    .replace(/@import\s+((?:'[^']*')|(?:"[^"]*"))/gi, (whole, raw: string) => {
      const next = one(raw);
      return next === null ? whole : `@import "${next.replace(/"/g, '%22')}"`;
    });
}

/**
 * Rewrite the URLs in a `srcset`.
 *
 * Not a split on commas: a `data:` URL contains one, and so may an ordinary
 * path or query. As the HTML parser does it, a candidate's URL runs to the
 * next whitespace, and only then do commas separate anything.
 */
export function rewriteSrcset(value: string, toProxy: (raw: string) => string | null): string {
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (isSpace(value[i]!) || value[i] === ',')) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !isSpace(value[i]!)) i++;
    let url = value.slice(start, i);
    // Trailing commas end the candidate on the spot: there is no descriptor.
    let hadComma = false;
    while (url.endsWith(',')) {
      url = url.slice(0, -1);
      hadComma = true;
    }
    let descriptor = '';
    if (!hadComma) {
      const next = value.indexOf(',', i);
      const end = next < 0 ? value.length : next;
      descriptor = value.slice(i, end).trim();
      i = end;
    }
    if (!url) continue;
    out.push((toProxy(url) ?? url) + (descriptor ? ` ${descriptor}` : ''));
  }
  return out.join(', ');
}

// base64url without Buffer or Node globals: this module is loaded in the
// browser as well as in the relay.
function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): string {
  const bin = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
