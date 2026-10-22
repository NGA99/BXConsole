/** "Copy as …" formats from the context menu. */
import type { NetworkEntry } from '../../state/session-data';
import { headerPairs, textOf } from './field-guard';

export function asCurl(e: NetworkEntry): string {
  const parts = [`curl '${sq(textOf(e.request.url))}'`];
  if (e.request.method !== 'GET') parts.push(`-X ${textOf(e.request.method) || 'GET'}`);
  for (const [k, v] of headerPairs(e.request.headers)) parts.push(`-H '${sq(`${k}: ${v}`)}'`);
  if (e.request.body) parts.push(`--data-raw '${sq(textOf(e.request.body))}'`);
  return parts.join(' \\\n  ');
}

export function asFetch(e: NetworkEntry): string {
  const init: Record<string, unknown> = { method: textOf(e.request.method) || 'GET' };
  const headers = headerPairs(e.request.headers);
  if (headers.length) init.headers = Object.fromEntries(headers);
  if (e.request.body) init.body = textOf(e.request.body);
  return `fetch(${JSON.stringify(textOf(e.request.url))}, ${JSON.stringify(init, null, 2)});`;
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
