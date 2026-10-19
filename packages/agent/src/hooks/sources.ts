/**
 * Sources tab: the page's document, scripts and stylesheets, and their text.
 * Text is fetched from inside the page (same origin as the page, so no CORS
 * trouble for its own files) with the original fetch, cache-first.
 */
import { isTextualMime, type SourceEntry, type SourceText } from '@bxconsole/protocol';
import { toBase64 } from '../bytes';
import { rawFetch } from './network';

const MAX_TEXT = 2 * 1024 * 1024;

export function listSources(): SourceEntry[] {
  const out: SourceEntry[] = [];
  const seen = new Set<string>();
  const push = (e: SourceEntry) => {
    if (seen.has(e.url)) return;
    seen.add(e.url);
    out.push(e);
  };

  push({ url: location.href.split('#')[0]!, kind: 'document', inline: false, label: '(index)' });

  Array.from(document.scripts).forEach((s, i) => {
    if (s.src) push({ url: s.src, kind: 'script', inline: false, label: nameOf(s.src) });
    else if (s.textContent?.trim())
      push({ url: inlineUrl('script', i, s.textContent), kind: 'script', inline: true, label: `(inline script ${i + 1})` });
  });
  Array.from(document.styleSheets).forEach((sheet, i) => {
    if (sheet.href) push({ url: sheet.href, kind: 'stylesheet', inline: false, label: nameOf(sheet.href) });
    else if (sheet.ownerNode && (sheet.ownerNode as Element).tagName === 'STYLE') {
      push({
        url: inlineUrl('style', i, (sheet.ownerNode as Element).textContent ?? ''),
        kind: 'stylesheet',
        inline: true,
        label: `(inline style ${i + 1})`,
      });
    }
  });
  // Scripts/styles loaded dynamically (import(), injected tags that were removed again).
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    const ext = (new URL(e.name, location.href).pathname.split('.').pop() ?? '').toLowerCase();
    if (['js', 'mjs', 'cjs'].includes(ext)) push({ url: e.name, kind: 'script', inline: false, label: nameOf(e.name) });
    else if (ext === 'css') push({ url: e.name, kind: 'stylesheet', inline: false, label: nameOf(e.name) });
  }
  return out;
}

export async function getSource(url: string): Promise<SourceText> {
  const inline = /^inline:\/\/(script|style)\/(\d+)(?:\/([a-z0-9]+))?$/.exec(url);
  if (inline) {
    const text = inlineText(inline[1] as 'script' | 'style', Number(inline[2]), inline[3]);
    return text === null ? { url, text: null, error: 'inline block no longer present' } : clamp(url, text);
  }
  try {
    const res = await rawFetch(url, { cache: 'force-cache', credentials: 'same-origin' });
    if (res.type === 'opaque') return { url, text: null, error: 'opaque response (no-cors): not readable from the page' };
    if (!res.ok) return { url, text: null, error: `HTTP ${res.status}` };
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || undefined;
    if (mimeType && !isTextualMime(mimeType)) {
      const buf = await res.arrayBuffer();
      const out = clamp(url, toBase64(buf));
      return { ...out, ...(mimeType ? { mimeType } : {}), encoding: 'base64' };
    }
    return { ...clamp(url, await res.text()), ...(mimeType ? { mimeType } : {}) };
  } catch (err) {
    // Last resort for the document itself: the live DOM (line numbers may differ from the original).
    if (url === location.href.split('#')[0]) return clamp(url, `<!-- live DOM; original could not be fetched -->\n${document.documentElement.outerHTML}`);
    return { url, text: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * An inline block's id: its position, plus a hash of what it held.
 *
 * Position alone is not an identity. A page that injects or drops a script
 * shifts every index after it, and an id handed out before that shift then
 * opens a different block — same name in the tree, someone else's code in
 * the viewer. The hash is what makes that detectable.
 */
function inlineUrl(kind: 'script' | 'style', index: number, text: string): string {
  return `inline://${kind}/${index}/${shortHash(text)}`;
}

/** The block that id names: at its old position if it still holds it, else wherever it moved. */
function inlineText(kind: 'script' | 'style', index: number, want: string | undefined): string | null {
  const texts =
    kind === 'script'
      ? Array.from(document.scripts).map((s) => (s.src ? null : s.textContent))
      : Array.from(document.styleSheets).map((sheet) => {
          const owner = sheet.ownerNode as Element | null;
          return owner && owner.tagName === 'STYLE' ? owner.textContent : null;
        });
  const atIndex = texts[index] ?? null;
  if (want === undefined) return atIndex; // an id from an older agent, position only
  if (atIndex !== null && shortHash(atIndex) === want) return atIndex;
  return texts.find((t) => t !== null && shortHash(t) === want) ?? null;
}

/** FNV-1a, base36. Short, and only ever compared against itself. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}



function clamp(url: string, text: string): SourceText {
  return text.length > MAX_TEXT ? { url, text: text.slice(0, MAX_TEXT), truncated: true } : { url, text };
}

function nameOf(url: string): string {
  try {
    const u = new URL(url, location.href);
    return (u.pathname.split('/').filter(Boolean).pop() ?? u.host) + (u.search ? '?…' : '');
  } catch {
    return url;
  }
}
