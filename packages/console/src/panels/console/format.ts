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
      // `v` is a string by type and arrives from the page: `{ t: 'string' }`
      // with no value at all reaches quote() below, which replaces on it. Read
      // through unknown because the declared type leaves no else branch.
      const reported: unknown = v.v;
      const raw = typeof reported === 'string' ? reported : reported === null || reported === undefined ? '' : String(reported);
      const text = v.truncated ? `${raw}…` : raw;
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
      // nodeName is reported by the page; null here used to throw.
      return `${String(v.nodeName ?? '').toLowerCase()}${id}${cls}`;
    }
    case 'promise':
      return 'Promise';
    case 'circular':
      return `[Circular ${v.path}]`;
    case 'getter':
      return '(...)';
    case 'unserializable':
      return v.description;
    case 'array': {
      if (mode === 'nested') return `Array(${v.length})`;
      const items = listOf<SerializedValue>(v.preview);
      return `(${v.length}) [${items.map((x) => formatValue(x, 'nested')).join(', ')}${
        v.truncated && items.length < v.length ? ', …' : ''
      }]`;
    }
    case 'object': {
      if (mode === 'nested') return v.className === 'Object' ? '{…}' : v.className;
      const props = listOf<{ name: string; value: SerializedValue }>(v.preview);
      return `${v.className === 'Object' ? '' : v.className + ' '}{${props
        .map((p) => `${p.name}: ${formatValue(p.value, 'nested')}`)
        .join(', ')}${v.truncated ? (props.length ? ', …' : '…') : ''}}`;
    }
    case 'map': {
      if (mode === 'nested') return `Map(${v.size})`;
      const entries = listOf<[SerializedValue, SerializedValue]>(v.preview);
      return `Map(${v.size}) {${entries
        .map(([k, val]) => `${formatValue(k, 'nested')} => ${formatValue(val, 'nested')}`)
        .join(', ')}${entries.length < v.size ? ', …' : ''}}`;
    }
    case 'set': {
      if (mode === 'nested') return `Set(${v.size})`;
      const members = listOf<SerializedValue>(v.preview);
      return `Set(${v.size}) {${members.map((x) => formatValue(x, 'nested')).join(', ')}${
        members.length < v.size ? ', …' : ''
      }}`;
    }
  }
}

export function plainText(args: SerializedValue[]): string {
  return listOf<SerializedValue>(args)
    .map((a) => formatValue(a, 'top'))
    .join(' ');
}

/**
 * The array a serialized value claims to carry, when it is one.
 *
 * `preview` and `args` are typed as arrays and arrive off the socket, so a
 * page can send null or a string instead. Reading `.map` or `.length` off that
 * threw during render and unmounted the panel.
 */
export function listOf<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
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
