/**
 * Turn arbitrary runtime values into `SerializedValue`.
 *
 * Objects get a shallow preview plus an `ObjectId` held in a registry so the
 * console can expand them later via `object.getProperties`. The registry is
 * a bounded LRU to avoid pinning everything the page ever logged.
 *
 * TODO: typed arrays, getter evaluation on demand, Symbol keys in previews.
 */
import type { ObjectId, PropertyPreview, SerializedValue } from '@bxconsole/protocol';
import { scopedId } from './ids';

const MAX_PREVIEW_PROPS = 10;
const MAX_PREVIEW_ITEMS = 100;
/**
 * How much of a string travels. The same ceiling a response body gets, and
 * for the same reason: what is cut here is cut in the page and cannot be
 * asked for again, so the ceiling should be the one the rest of the tool
 * already thinks is a reasonable thing to carry.
 *
 * It was 10,000, which is shorter than plenty of things worth reading — a
 * token, a serialised form, the HTML of a panel. The cost is that a page
 * logging large strings repeatedly makes console.ndjson bigger; network
 * bodies solve that by moving past a couple of kilobytes into the blob
 * store, and console arguments do not do that yet.
 */
const MAX_STRING = 64 * 1024;
const MAX_REGISTRY = 5000;
/** Nesting beyond this ships only class/length + an id; the UI expands lazily. */
const MAX_DEPTH = 2;

const registry = new Map<ObjectId, WeakRef<object>>();
let nextId = 1;

/**
 * @param seen  the objects currently being walked, each against the path it
 *              was entered at. A map rather than a set because a cycle has to
 *              report where it *goes*, which is where that object already
 *              sits, not where the walk happened to notice it.
 */
export function serialize(value: unknown, path = '$', seen = new Map<unknown, string>(), depth = 0): SerializedValue {
  switch (typeof value) {
    case 'undefined':
      return { t: 'undefined' };
    case 'boolean':
      return { t: 'boolean', v: value };
    case 'number':
      return { t: 'number', v: serializeNumber(value) };
    case 'bigint':
      return { t: 'bigint', v: value.toString() };
    case 'string':
      // The length goes with it. What is cut here is cut in the page and
      // cannot be asked for again, so the reader needs to know how much of it
      // they are looking at — the same thing an array says about its items.
      return value.length > MAX_STRING
        ? { t: 'string', v: value.slice(0, MAX_STRING), truncated: true, length: value.length }
        : { t: 'string', v: value };
    case 'symbol':
      return { t: 'symbol', v: value.toString() };
    case 'function':
      return { t: 'function', name: value.name || '', id: remember(value) };
  }
  if (value === null) return { t: 'null' };
  const at = seen.get(value);
  // `$.self` for `a.self = a` reads as pointing at itself. It points at `$`.
  if (at !== undefined) return { t: 'circular', path: at };
  seen.set(value, path);
  try {
    return serializeObject(value as object, path, seen, depth);
  } finally {
    seen.delete(value);
  }
}

function serializeObject(obj: object, path: string, seen: Map<unknown, string>, depth: number): SerializedValue {

  if (obj instanceof Error) {
    const cause = (obj as Error & { cause?: unknown }).cause;
    return {
      t: 'error',
      name: obj.name,
      message: obj.message,
      stack: obj.stack ?? undefined,
      ...(cause !== undefined && depth < MAX_DEPTH ? { cause: serialize(cause, `${path}.cause`, seen, depth + 1) } : {}),
      id: remember(obj),
    };
  }
  if (obj instanceof Date) return { t: 'date', v: String(obj) };
  if (obj instanceof RegExp) return { t: 'regexp', v: obj.toString() };
  if (obj instanceof Promise) return { t: 'promise', id: remember(obj) };
  if (typeof Node !== 'undefined' && obj instanceof Node) return serializeNode(obj);

  const deep = depth >= MAX_DEPTH;
  const next = depth + 1;

  if (Array.isArray(obj)) {
    const preview = deep ? [] : obj.slice(0, MAX_PREVIEW_ITEMS).map((v, i) => serialize(v, `${path}[${i}]`, seen, next));
    return { t: 'array', length: obj.length, preview, truncated: deep || obj.length > MAX_PREVIEW_ITEMS, id: remember(obj) };
  }
  if (obj instanceof Map) {
    const preview: Array<[SerializedValue, SerializedValue]> = [];
    if (!deep) {
      for (const [k, v] of obj) {
        if (preview.length >= MAX_PREVIEW_PROPS) break;
        preview.push([serialize(k, `${path}.key`, seen, next), serialize(v, `${path}.value`, seen, next)]);
      }
    }
    return { t: 'map', size: obj.size, preview, id: remember(obj) };
  }
  if (obj instanceof Set) {
    const preview: SerializedValue[] = [];
    if (!deep) {
      for (const v of obj) {
        if (preview.length >= MAX_PREVIEW_PROPS) break;
        preview.push(serialize(v, `${path}.item`, seen, next));
      }
    }
    return { t: 'set', size: obj.size, preview, id: remember(obj) };
  }

  // A typed array or any very large indexed object would otherwise have every
  // index enumerated to show ten of them, which freezes the page on a few MB.
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    const view = obj as unknown as { length: number; [i: number]: number };
    const preview: PropertyPreview[] = [];
    for (let i = 0; i < Math.min(view.length, MAX_PREVIEW_PROPS); i++) {
      preview.push({ name: String(i), value: serialize(view[i], `${path}[${i}]`, seen, next), enumerable: true });
    }
    return { t: 'object', className: classNameOf(obj), preview: deep ? [] : preview, truncated: deep || view.length > MAX_PREVIEW_PROPS, id: remember(obj) };
  }

  return {
    t: 'object',
    className: classNameOf(obj),
    preview: deep ? [] : previewProperties(obj, path, seen, next),
    truncated: deep || tooManyKeys(obj),
    id: remember(obj),
  };
}

export function objectById(id: ObjectId): object | undefined {
  return registry.get(id)?.deref();
}

/** Full own-property listing for `object.getProperties`, plus [[Prototype]] like DevTools. */
export function propertiesOf(id: ObjectId): PropertyPreview[] | null {
  const obj = registry.get(id)?.deref();
  if (!obj) return null;
  const out: PropertyPreview[] = [];
  for (const name of Reflect.ownKeys(obj)) {
    const key = typeof name === 'symbol' ? name.toString() : name;
    const desc = Reflect.getOwnPropertyDescriptor(obj, name);
    if (!desc) continue;
    if (desc.get && !('value' in desc)) {
      out.push({ name: key, value: { t: 'unserializable', description: '(getter)' }, getter: true, enumerable: desc.enumerable ?? false });
      continue;
    }
    out.push({ name: key, value: serialize(desc.value, `$.${key}`), enumerable: desc.enumerable ?? false });
  }
  const proto = Object.getPrototypeOf(obj) as object | null;
  if (proto) out.push({ name: '[[Prototype]]', value: serialize(proto, '$.__proto__'), enumerable: false });
  return out;
}

function previewProperties(obj: object, path: string, seen: Map<unknown, string>, depth: number): PropertyPreview[] {
  const out: PropertyPreview[] = [];
  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    return out; // a proxy that throws on ownKeys
  }
  for (const key of keys) {
    if (out.length >= MAX_PREVIEW_PROPS) break;
    let v: unknown;
    try {
      // Read the descriptor first: invoking a getter here would run the page's
      // own side effects merely because the object was logged, which DevTools
      // deliberately does not do. Expanding the row still invokes it on demand.
      const d = Object.getOwnPropertyDescriptor(obj, key);
      if (d && !('value' in d)) {
        out.push({ name: key, value: { t: 'getter' }, enumerable: !!d.enumerable });
        continue;
      }
      v = d ? d.value : undefined;
    } catch (e) {
      v = e;
    }
    out.push({ name: key, value: serialize(v, `${path}.${key}`, seen, depth), enumerable: true });
  }
  return out;
}

/** Counting keys is itself the expensive part on exotic objects, so guard it. */
function tooManyKeys(obj: object): boolean {
  try {
    return Object.keys(obj).length > MAX_PREVIEW_PROPS;
  } catch {
    return false;
  }
}

function serializeNode(node: Node): SerializedValue {
  const el = node.nodeType === 1 ? (node as Element) : null;
  const attrs: Record<string, string> = {};
  if (el) for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const preview = el ? el.outerHTML.slice(0, 200) : node.nodeValue?.slice(0, 200) ?? node.nodeName;
  return { t: 'node', nodeType: node.nodeType, nodeName: node.nodeName, attrs, preview, id: remember(node) };
}

function serializeNumber(n: number): number | 'NaN' | 'Infinity' | '-Infinity' | '-0' {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (n === 0 && 1 / n < 0) return '-0';
  return n;
}

function classNameOf(obj: object): string {
  const proto = Object.getPrototypeOf(obj) as { constructor?: { name?: string } } | null;
  return proto?.constructor?.name ?? 'Object';
}

function remember(obj: object): ObjectId {
  if (registry.size >= MAX_REGISTRY) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  const id = scopedId(nextId++);
  registry.set(id, new WeakRef(obj));
  return id;
}
