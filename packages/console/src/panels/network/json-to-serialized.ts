/**
 * Turn parsed JSON into a SerializedValue so the Preview tab can reuse
 * ObjectTree.
 *
 * Bounded on purpose. The whole tree used to be converted the moment a
 * request was selected, however little of it the viewer would ever open: a
 * fifty-thousand-row API response meant fifty thousand objects allocated and
 * a visible freeze, to draw one collapsed line. What is cut is marked, and
 * the Response tab still holds the text in full.
 */
import type { PropertyPreview, SerializedValue } from '@bxconsole/protocol';

/** Entries converted per level before the rest is summarised. */
const MAX_ENTRIES = 200;
/** How deep to go before a value is shown as a stub. */
const MAX_DEPTH = 6;

export function toSerialized(v: unknown, depth = 0): SerializedValue {
  if (v === null) return { t: 'null' };
  switch (typeof v) {
    case 'string':
      return { t: 'string', v };
    case 'number':
      return { t: 'number', v: Number.isNaN(v) ? 'NaN' : v };
    case 'boolean':
      return { t: 'boolean', v };
    case 'undefined':
      return { t: 'undefined' };
  }
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return { t: 'unserializable', description: `Array(${v.length})` };
    const preview = v.slice(0, MAX_ENTRIES).map((item) => toSerialized(item, depth + 1));
    if (v.length > MAX_ENTRIES) preview.push(cutMarker(v.length - MAX_ENTRIES, 'items'));
    return { t: 'array', length: v.length, preview };
  }
  if (typeof v === 'object') {
    if (depth >= MAX_DEPTH) return { t: 'unserializable', description: '{…}' };
    const entries = Object.entries(v as Record<string, unknown>);
    const preview: PropertyPreview[] = entries
      .slice(0, MAX_ENTRIES)
      .map(([name, value]) => ({ name, value: toSerialized(value, depth + 1) }));
    if (entries.length > MAX_ENTRIES) {
      preview.push({ name: '…', value: cutMarker(entries.length - MAX_ENTRIES, 'properties') });
    }
    return { t: 'object', className: 'Object', preview };
  }
  return { t: 'unserializable', description: String(v) };
}

function cutMarker(rest: number, noun: string): SerializedValue {
  return { t: 'unserializable', description: `… ${rest.toLocaleString()} more ${noun} — see the Response tab` };
}

export function tryParseJson(text: string | null | undefined): unknown | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
