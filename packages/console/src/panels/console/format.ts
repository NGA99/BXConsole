/**
 * Text rendering of SerializedValue, in the three contexts DevTools uses:
 *
 *   top      a bare argument of console.log: strings unquoted
 *   preview  the one-line header of an object: `{a: 1, b: {…}, c: Array(3)}`
 *   nested   a value inside a preview: strings quoted, compounds abbreviated
 *
 * `plainText` is the filter/copy form.
 */
import type { SerializedValue } from '@bxconsole/protocol';

export type FormatMode = 'top' | 'preview' | 'nested';

export function formatValue(v: SerializedValue, mode: FormatMode = 'top'): string {
  switch (v.t) {
    case 'undefined':
      return 'undefined';
    case 'null':
      return 'null';
    case 'boolean':
    case 'number':
      return String(v.v);
    case 'bigint':
      return `${v.v}n`;
    case 'string': {
      const text = v.truncated ? `${v.v}…` : v.v;
      return mode === 'top' ? text : quote(text);
    }
    case 'symbol':
    case 'regexp':
      return v.v;
    case 'date':
      return v.v;
    case 'function':
      return mode === 'nested' ? 'ƒ' : `ƒ ${v.name}()`;
    case 'error':
      return mode === 'nested' ? `${v.name}: ${v.message}` : v.stack ?? `${v.name}: ${v.message}`;
    case 'node': {
      if (mode !== 'nested' || v.nodeType !== 1) return v.preview;
      const id = v.attrs?.id ? `#${v.attrs.id}` : '';
      const cls = v.attrs?.class ? v.attrs.class.trim().split(/\s+/).filter(Boolean).map((c) => `.${c}`).join('') : '';
      return `${v.nodeName.toLowerCase()}${id}${cls}`;
    }
    case 'promise':
      return 'Promise';
    case 'circular':
      return `[Circular ${v.path}]`;
    case 'getter':
      return '(...)';
    case 'unserializable':
      return v.description;
    case 'array':
      if (mode === 'nested') return `Array(${v.length})`;
      return `(${v.length}) [${v.preview.map((x) => formatValue(x, 'nested')).join(', ')}${
        v.truncated && v.preview.length < v.length ? ', …' : ''
      }]`;
    case 'object':
      if (mode === 'nested') return v.className === 'Object' ? '{…}' : v.className;
      return `${v.className === 'Object' ? '' : v.className + ' '}{${v.preview
        .map((p) => `${p.name}: ${formatValue(p.value, 'nested')}`)
        .join(', ')}${v.truncated ? (v.preview.length ? ', …' : '…') : ''}}`;
    case 'map':
      if (mode === 'nested') return `Map(${v.size})`;
      return `Map(${v.size}) {${v.preview
        .map(([k, val]) => `${formatValue(k, 'nested')} => ${formatValue(val, 'nested')}`)
        .join(', ')}${v.preview.length < v.size ? ', …' : ''}}`;
    case 'set':
      if (mode === 'nested') return `Set(${v.size})`;
      return `Set(${v.size}) {${v.preview.map((x) => formatValue(x, 'nested')).join(', ')}${
        v.preview.length < v.size ? ', …' : ''
      }}`;
  }
}

export function plainText(args: SerializedValue[]): string {
  return args.map((a) => formatValue(a, 'top')).join(' ');
}

export function isCompound(v: SerializedValue): boolean {
  switch (v.t) {
    case 'object':
    case 'array':
    case 'map':
    case 'set':
    case 'function':
    case 'error':
    case 'node':
    case 'promise':
      return true;
    default:
      return false;
  }
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}
