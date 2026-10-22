/**
 * Screen stream ops, filtered down to the ones that can actually be applied.
 *
 * `SnapshotNode` and `ScreenOp` are TypeScript types, and TypeScript is not
 * there when the message arrives: the debugged page chooses these field types
 * as freely as their contents. A node whose `children` is null, an `attr` op
 * with a numeric name, a tag of `div<script>` — each of those threw somewhere
 * inside the mirror or the Elements model, and the stream is applied from an
 * effect, so the failure landed as a dead mirror or an unmounted panel.
 *
 * Both consumers of the stream run it through here: the mirror that rebuilds
 * the document and the model the Elements tree reads, live and on replay.
 * Anything unusable is dropped rather than repaired — an op addressing a node
 * that was dropped is simply an unknown id, which the mirror already counts
 * and tolerates.
 */
import type { ScreenOp, SnapshotNode } from '@bxconsole/protocol';

/*
 * There is deliberately no check on the tag name here.
 *
 * The first version of this file tried to predict what `document.createElement`
 * accepts, and got it wrong in both directions: `<x-日本>` and
 * `<ÉlémentCustom>` were dropped although they are ordinary custom elements,
 * and fuzzing the predicate against the real `createElement` across four
 * thousand names found two hundred disagreements the other way — it accepts a
 * bare space, and control characters, and refuses things that look fine. It is
 * not a clean rule, so predicting it is the wrong shape of solution.
 *
 * Only the mirror needs a name the DOM will take, so that is where the failure
 * is handled, next to the call that can throw (see `build` in mirror.ts). The
 * Elements model never calls createElement at all — it keeps the tree as plain
 * data — so a tag only has to be a non-empty string to be worth carrying.
 */

/**
 * How deep a mirrored tree may nest.
 *
 * Both consumers build the tree by recursing, and so does this file, so a
 * snapshot nested a couple of thousand deep overflowed the stack — in the
 * transport callback, where no error boundary can catch it, leaving the
 * Elements tree and the mirror dead with nothing on screen to say why. A page
 * makes one with `appendChild` in a loop.
 *
 * 256 is five times deeper than any real page and well under where the stack
 * gives out (somewhere past a thousand), and the tree is cut with a marker
 * rather than silently, the way json-to-serialized.ts handles the same problem
 * for a deeply nested body.
 */
const MAX_DEPTH = 256;

/*
 * Marker nodes need an id, and the real ones come from the page's own counter
 * and are addressed by later ops. Counting down from zero keeps these out of
 * that space entirely, so a marker can never stand in for a node an op means.
 */
let markerId = 0;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** The nodes of a snapshot that can be built, in order. */
export function usableSnapshot(doc: unknown, depth = 0): SnapshotNode[] {
  if (!Array.isArray(doc)) return [];
  const out: SnapshotNode[] = [];
  for (const n of doc) {
    const node = usableNode(n, depth);
    if (node) out.push(node);
  }
  return out;
}

/** One node, with its fields made real, or null when it cannot be built at all. */
export function usableNode(raw: unknown, depth = 0): SnapshotNode | null {
  if (!isObj(raw) || !isId(raw.id)) return null;
  const id = raw.id;
  switch (raw.t) {
    case 'tx':
      return { id, t: 'tx', text: str(raw.text) };
    case 'cm':
      return { id, t: 'cm', text: str(raw.text) };
    case 'doctype':
      return { id, t: 'doctype', name: str(raw.name) || 'html' };
    case 'el': {
      const tag = typeof raw.tag === 'string' ? raw.tag : '';
      if (!tag) return null;
      const attrs: Record<string, string> = {};
      if (isObj(raw.attrs)) {
        for (const [k, v] of Object.entries(raw.attrs)) {
          // An attribute name the DOM refuses would throw on setAttribute. The
          // mirror catches that one, but the Elements tree renders the pair as
          // text and has no reason to carry a name nothing can hold.
          if (typeof k === 'string' && k && !/[\s"'>/=]/.test(k)) attrs[k] = str(v);
        }
      }
      const children = depth >= MAX_DEPTH ? [depthMarker(raw.children)] : usableSnapshot(raw.children, depth + 1);
      const ns = typeof raw.ns === 'string' ? raw.ns : undefined;
      return { id, t: 'el', tag, attrs, children, ...(ns ? { ns } : {}) };
    }
    default:
      return null;
  }
}

/**
 * Stands in for the subtree below MAX_DEPTH, so the cut is visible rather than
 * silent — this is a tool for reading a page, and quietly showing a shallower
 * tree than the page has would be the wrong kind of wrong.
 *
 * It says how many children were dropped here, not how much is under them:
 * counting the whole subtree would mean walking it, which is the thing being
 * avoided.
 */
function depthMarker(children: unknown): SnapshotNode {
  const n = Array.isArray(children) ? children.length : 0;
  return {
    id: --markerId,
    t: 'cm',
    text: ` bxconsole: nesting past ${MAX_DEPTH} levels is not shown (${n} child${n === 1 ? '' : 'ren'} dropped here) `,
  };
}

/** The ops in a batch that are shaped well enough to apply, in order. */
export function usableOps(ops: unknown): ScreenOp[] {
  if (!Array.isArray(ops)) return [];
  const out: ScreenOp[] = [];
  for (const raw of ops) {
    const op = usableOp(raw);
    if (op) out.push(op);
  }
  return out;
}

function usableOp(raw: unknown): ScreenOp | null {
  if (!isObj(raw) || typeof raw.op !== 'string') return null;
  switch (raw.op) {
    case 'add': {
      if (!isId(raw.parentId)) return null;
      const node = usableNode(raw.node);
      if (!node) return null;
      return { op: 'add', parentId: raw.parentId, nextId: isId(raw.nextId) ? raw.nextId : null, node };
    }
    case 'remove':
      return isId(raw.id) ? { op: 'remove', id: raw.id } : null;
    case 'attr': {
      if (!isId(raw.id) || typeof raw.name !== 'string' || !raw.name) return null;
      if (/[\s"'>/=]/.test(raw.name)) return null;
      return { op: 'attr', id: raw.id, name: raw.name, value: raw.value === null ? null : str(raw.value) };
    }
    case 'text':
      return isId(raw.id) ? { op: 'text', id: raw.id, text: str(raw.text) } : null;
    case 'input': {
      if (!isId(raw.id)) return null;
      return {
        op: 'input',
        id: raw.id,
        ...(raw.value === undefined ? {} : { value: str(raw.value) }),
        ...(raw.checked === undefined ? {} : { checked: !!raw.checked }),
      };
    }
    case 'scroll': {
      if (raw.id !== null && !isId(raw.id)) return null;
      // A NaN here would land in scrollTo and scroll nothing, silently.
      if (!isId(raw.x) || !isId(raw.y)) return null;
      return { op: 'scroll', id: raw.id as number | null, x: raw.x, y: raw.y };
    }
    case 'viewport':
      return isId(raw.width) && isId(raw.height) ? { op: 'viewport', width: raw.width, height: raw.height } : null;
    case 'focus':
      return raw.id === null || isId(raw.id) ? { op: 'focus', id: raw.id as number | null } : null;
    default:
      // An op this console does not know is not an error; a later agent may
      // send one, and the rest of the batch still applies.
      return null;
  }
}
