/** "Copy as …" formats from the context menu. */
import type { NetworkEntry } from '../../state/session-data';

export function asCurl(e: NetworkEntry): string {
  const parts = [`curl '${sq(e.request.url)}'`];
  if (e.request.method !== 'GET') parts.push(`-X ${e.request.method}`);
  for (const [k, v] of Object.entries(e.request.headers)) parts.push(`-H '${sq(`${k}: ${v}`)}'`);
  if (e.request.body) parts.push(`--data-raw '${sq(e.request.body)}'`);
  return parts.join(' \\\n  ');
}

export function asFetch(e: NetworkEntry): string {
  const init: Record<string, unknown> = { method: e.request.method };
  if (Object.keys(e.request.headers).length) init.headers = e.request.headers;
  if (e.request.body) init.body = e.request.body;
  return `fetch(${JSON.stringify(e.request.url)}, ${JSON.stringify(init, null, 2)});`;
}

/** Expression evaluated in the page for "Replay XHR": same request, result ignored. */
export function replayExpression(e: NetworkEntry): string {
  return asFetch(e).replace(/;$/, '');
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function sq(s: string): string {
  return s.replace(/'/g, `'\\''`);
}
