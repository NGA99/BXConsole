/**
 * printf-style substitution for the first console argument, as DevTools does:
 * %s %d %i %f %o %O %c %%. `%c` carries inline CSS onto the following text.
 */
import type { SerializedValue } from '@bxconsole/protocol';
import type { CSSProperties } from 'react';
import { formatValue, listOf } from './format';

export type Segment =
  | { kind: 'text'; text: string; style?: CSSProperties }
  | { kind: 'value'; value: SerializedValue; style?: CSSProperties };

const SPEC = /%([sdifoOc%])/g;

export function applyFormat(rawArgs: SerializedValue[]): Segment[] {
  // Typed as an array, delivered by the page: destructuring a null here threw
  // out of the render of the row.
  const args = listOf<SerializedValue>(rawArgs);
  const [first, ...rest] = args;
  if (!first || first.t !== 'string' || typeof first.v !== 'string' || !SPEC.test(first.v)) {
    return args.map((value) => ({ kind: 'value', value }));
  }
  SPEC.lastIndex = 0;

  const out: Segment[] = [];
  const queue = [...rest];
  let style: CSSProperties | undefined;
  let last = 0;
  let buffer = '';

  const flush = () => {
    if (buffer) out.push({ kind: 'text', text: buffer, style });
    buffer = '';
  };

  for (const m of first.v.matchAll(SPEC)) {
    buffer += first.v.slice(last, m.index);
    last = m.index! + m[0].length;
    const spec = m[1]!;

    if (spec === '%') {
      buffer += '%';
      continue;
    }
    if (queue.length === 0) {
      buffer += m[0];
      continue;
    }
    const arg = queue.shift()!;
    switch (spec) {
      case 's':
        buffer += formatValue(arg, 'top');
        break;
      case 'd':
      case 'i':
        buffer += toInt(arg);
        break;
      case 'f':
        buffer += toFloat(arg);
        break;
      case 'o':
      case 'O':
        flush();
        out.push({ kind: 'value', value: arg, style });
        break;
      case 'c':
        flush();
        // `%c` takes its CSS from the next argument, which the page may send
        // as a `string` value with no `v` at all.
        style = arg.t === 'string' && typeof arg.v === 'string' ? parseCss(arg.v) : undefined;
        break;
    }
  }
  buffer += first.v.slice(last);
  flush();

  for (const value of queue) out.push({ kind: 'value', value });
  return out;
}

function toInt(v: SerializedValue): string {
  if (v.t === 'number') return typeof v.v === 'number' ? String(Math.trunc(v.v)) : 'NaN';
  if (v.t === 'string') {
    const n = parseInt(v.v, 10);
    return Number.isNaN(n) ? 'NaN' : String(n);
  }
  if (v.t === 'bigint') return v.v;
  return 'NaN';
}

function toFloat(v: SerializedValue): string {
  if (v.t === 'number') return String(v.v);
  if (v.t === 'string') {
    const n = parseFloat(v.v);
    return Number.isNaN(n) ? 'NaN' : String(n);
  }
  return 'NaN';
}

/** `color: red; font-weight: bold` -> React style object. Layout props are dropped like DevTools does. */
const ALLOWED = /^(color|background|background-color|font-weight|font-style|font-size|font-family|text-decoration|border|border-radius|padding|margin|line-height|text-shadow|letter-spacing)$/;

function parseCss(css: string): CSSProperties {
  const style: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!ALLOWED.test(prop) || !value) continue;
    style[prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return style as CSSProperties;
}
