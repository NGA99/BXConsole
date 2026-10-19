/**
 * Subresource fetching on behalf of the console.
 *
 * The Screen mirror needs the page's images, stylesheets and fonts to draw
 * anything recognisable. Letting the console's browser load them from the
 * original URLs looks like it works and quietly does the wrong thing: an
 * intranet host it cannot route to, a login it has no cookies for, and — the
 * one that is worse than failing — a `localhost` address that resolves to the
 * console machine instead of the debugged one.
 *
 * So the page fetches them, with its own network and its own credentials, and
 * hands the bytes back through the relay. `rawFetch` is the untouched fetch
 * captured before the Network hook patched it, so none of this shows up as
 * page traffic.
 */
import type { AssetData } from '@bxconsole/protocol';
import { toBase64 } from '../bytes';
import { rawFetch } from './network';

/** Per asset. Big enough for a hero image or an icon font, not for a video. */
const MAX_BYTES = 8 * 1024 * 1024;

export async function getAsset(url: string): Promise<AssetData> {
  let abs: string;
  try {
    abs = new URL(url, location.href).href;
  } catch {
    return { url, error: 'not a URL' };
  }
  // data: needs no fetching and blob: belongs to this document, which is
  // exactly why the console cannot read it and we can.
  if (/^(javascript|about):/i.test(abs)) return { url: abs, error: 'not a fetchable URL' };
  try {
    const res = await rawFetch(abs, { cache: 'force-cache', credentials: 'same-origin' });
    // A no-cors response has a body the page itself is not allowed to read.
    if (res.type === 'opaque') return { url: abs, error: 'opaque response (no CORS): the page cannot read it either' };
    if (!res.ok) return { url: abs, status: res.status, error: `HTTP ${res.status}` };
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) return { url: abs, status: res.status, error: `too large (${declared} bytes)` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { url: abs, status: res.status, error: `too large (${buf.byteLength} bytes)` };
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    return {
      url: abs,
      status: res.status,
      body: toBase64(buf),
      ...(mimeType ? { mimeType } : {}),
    };
  } catch (err) {
    return { url: abs, error: err instanceof Error ? err.message : String(err) };
  }
}

