/**
 * The agent's replies, made safe to render.
 *
 * Everything here crossed the socket from a page the operator does not
 * control, and the types on the other side are TypeScript's word rather than
 * a guarantee: `ElementStyles.rules` can arrive as null, a `SourceEntry.url`
 * as a number, a property name as an object. The panels then hand those to
 * `.split`, `.map`, `new URL` and React, and an error thrown in render
 * unmounts the panel.
 *
 * These run once, where each reply arrives, so the panels downstream can go
 * on treating the types as true. The shape is kept and the values are coerced
 * or dropped; nothing is invented.
 */
import type { Declaration, ElementStyles, InheritedStyles, MatchedRule, PropertyPreview, SerializedValue, SourceEntry, SourceText } from '@bxconsole/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Strings only, for the places that render a bare list of names. */
export function listOfStrings(v: unknown): string[] {
  return list(v).filter((x): x is string => typeof x === 'string');
}

/**
 * A serialized value, left alone apart from its type tag.
 *
 * The renderers switch on `t` and already have a default arm, and the pieces
 * they read out of each arm are guarded where they are read (see
 * `panels/console/format.ts`). What matters here is that `t` is a string, so
 * the switch cannot be handed an object.
 */
function value(v: unknown): SerializedValue {
  if (!isObj(v) || typeof v.t !== 'string') return { t: 'undefined' };
  return v as unknown as SerializedValue;
}

export function usableProperties(v: unknown): PropertyPreview[] | null {
  // null is meaningful here: the object was collected or the id is unknown.
  if (v === null || v === undefined) return null;
  return list(v)
    .filter(isObj)
    .map((p) => ({
      name: str(p.name),
      value: value(p.value),
      ...(p.enumerable === undefined ? {} : { enumerable: !!p.enumerable }),
    })) as PropertyPreview[];
}

export function usableSources(v: unknown): SourceEntry[] {
  return list(v)
    .filter(isObj)
    .map((e) => ({
      url: str(e.url),
      kind: e.kind === 'document' || e.kind === 'stylesheet' ? e.kind : 'script',
      inline: !!e.inline,
      label: str(e.label),
    }));
}

export function usableSourceText(v: unknown): SourceText | null {
  if (!isObj(v)) return null;
  return {
    url: str(v.url),
    // null is how "no text" is said; anything else that is not a string is a
    // value the viewer would try to split into lines.
    text: v.text === null || v.text === undefined ? null : str(v.text),
    ...(v.mimeType === undefined ? {} : { mimeType: str(v.mimeType) }),
    ...(v.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
    ...(v.error === undefined ? {} : { error: str(v.error) }),
    ...(v.truncated === undefined ? {} : { truncated: !!v.truncated }),
    ...(v.fromStore === undefined ? {} : { fromStore: !!v.fromStore }),
  };
}

function declarations(v: unknown): Declaration[] {
  return list(v)
    .filter(isObj)
    .map((d) => ({ name: str(d.name), value: str(d.value), important: !!d.important }));
}

function rules(v: unknown): MatchedRule[] {
  return list(v)
    .filter(isObj)
    .map((r, i) => {
      const spec = list(r.specificity);
      return {
        selector: str(r.selector),
        source: str(r.source),
        ...(r.media === undefined ? {} : { media: str(r.media) }),
        declarations: declarations(r.declarations),
        // The cascade sorts on these, so a missing one must not make the
        // comparison undefined: that is how a sort goes non-deterministic.
        specificity: [num(spec[0]), num(spec[1]), num(spec[2])] as [number, number, number],
        order: typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : i,
      };
    });
}

function inherited(v: unknown): InheritedStyles[] {
  return list(v)
    .filter(isObj)
    .map((inh) => ({
      from: str(inh.from),
      fromId: typeof inh.fromId === 'number' && Number.isFinite(inh.fromId) ? inh.fromId : null,
      inline: declarations(inh.inline),
      rules: rules(inh.rules),
    }));
}

function sides(v: unknown): [number, number, number, number] {
  const a = list(v);
  return [num(a[0]), num(a[1]), num(a[2]), num(a[3])];
}

export function usableStyles(v: unknown): ElementStyles | null {
  if (!isObj(v)) return null;
  const box = isObj(v.box) ? v.box : {};
  return {
    inline: declarations(v.inline),
    rules: rules(v.rules),
    inherited: inherited(v.inherited),
    // Pairs, because the Computed pane destructures every entry.
    computed: list(v.computed)
      .filter((e): e is unknown[] => Array.isArray(e))
      .map((e) => [str(e[0]), str(e[1])] as [string, string]),
    box: {
      margin: sides(box.margin),
      border: sides(box.border),
      padding: sides(box.padding),
      width: num(box.width),
      height: num(box.height),
    },
    unreadableSheets: num(v.unreadableSheets),
  };
}
