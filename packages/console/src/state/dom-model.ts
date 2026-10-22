/**
 * In-memory DOM tree for the Elements tab, built from the same Screen stream
 * the mirror uses (snapshot + mutation ops), so node ids match the Screen
 * highlight and the agent's dom.* commands. One model per session; a zustand
 * version counter lets React re-render on change.
 */
import { create } from 'zustand';
import type { ScreenEvent, ScreenOp, SnapshotNode } from '@bxconsole/protocol';
import { usableOps, usableSnapshot } from '../panels/screen/op-guard';
import { useElementsSelection } from './elements-selection';

export interface DomNode {
  id: number;
  t: 'el' | 'tx' | 'cm' | 'doctype';
  tag?: string;
  attrs: Record<string, string>;
  text?: string;
  children: number[];
  parent: number | null;
}

export class DomModel {
  readonly nodes = new Map<number, DomNode>();
  roots: number[] = [];
  loaded = false;
  /** incremented on every snapshot: ids are not comparable across snapshots */
  generation = 0;

  load(rawSnapshot: SnapshotNode[]): void {
    // The same filter the mirror uses, so both views of the stream agree on
    // which nodes exist and keep their ids comparable.
    const snapshot = usableSnapshot(rawSnapshot);
    this.nodes.clear();
    this.roots = snapshot.map((n) => this.build(n, null));
    this.loaded = true;
    this.generation++;
  }

  /** depth-first list of ids under (and including) `id` */
  descendants(id: number): number[] {
    const out: number[] = [];
    const walk = (n: number) => {
      out.push(n);
      for (const c of this.nodes.get(n)?.children ?? []) walk(c);
    };
    walk(id);
    return out;
  }

  /** nodes whose tag, id, class, attribute values or text contain `q` (case-insensitive), in document order, capped */
  search(q: string, limit = 2000): number[] {
    const lower = q.toLowerCase();
    const out = new Set<number>();
    // Where each node sits in the walk. An element matched by its own text is
    // recorded when the text child is reached, which is after any descendant
    // that matched on its own — insertion order alone put Enter-to-cycle out
    // of document order, so the positions are kept and sorted at the end.
    const order = new Map<number, number>();
    let seq = 0;
    const walk = (id: number): boolean => {
      const n = this.nodes.get(id);
      if (!n) return true;
      order.set(id, seq++);
      if (n.t === 'el') {
        let hit = n.tag!.includes(lower);
        if (!hit) for (const k in n.attrs) if (k.includes(lower) || n.attrs[k]!.toLowerCase().includes(lower)) { hit = true; break; }
        if (hit) out.add(id);
      } else if (n.t === 'tx' && n.parent !== null && n.text && n.text.toLowerCase().includes(lower)) out.add(n.parent);
      if (out.size >= limit) return false;
      for (const c of n.children) if (!walk(c)) return false;
      return true;
    };
    for (const r of this.roots) if (!walk(r)) break;
    return Array.from(out).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  apply(rawOps: ScreenOp[]): boolean {
    let changed = false;
    for (const op of usableOps(rawOps)) {
      switch (op.op) {
        case 'add': {
          const parent = this.nodes.get(op.parentId);
          if (!parent) break;
          const id = this.build(op.node, parent.id);
          const idx = op.nextId === null ? -1 : parent.children.indexOf(op.nextId);
          if (idx < 0) parent.children.push(id);
          else parent.children.splice(idx, 0, id);
          changed = true;
          break;
        }
        case 'remove': {
          const n = this.nodes.get(op.id);
          if (!n) break;
          const parent = n.parent === null ? null : this.nodes.get(n.parent);
          if (parent) parent.children = parent.children.filter((c) => c !== op.id);
          else this.roots = this.roots.filter((c) => c !== op.id);
          this.forget(op.id);
          changed = true;
          break;
        }
        case 'attr': {
          const n = this.nodes.get(op.id);
          if (!n) break;
          if (op.value === null) delete n.attrs[op.name];
          else n.attrs[op.name] = op.value;
          changed = true;
          break;
        }
        case 'text': {
          const n = this.nodes.get(op.id);
          if (!n) break;
          n.text = op.text;
          changed = true;
          break;
        }
        default:
          break;
      }
    }
    return changed;
  }

  get(id: number): DomNode | undefined {
    return this.nodes.get(id);
  }

  /** ids from the root down to `id`, inclusive */
  pathTo(id: number): number[] {
    const path: number[] = [];
    // The ids come from the page, so a cycle has to be survivable: without the
    // guard a node that ends up its own ancestor spins here and takes the
    // whole console tab with it.
    const seen = new Set<number>();
    for (let n = this.nodes.get(id); n && !seen.has(n.id); n = n.parent === null ? undefined : this.nodes.get(n.parent)) {
      seen.add(n.id);
      path.unshift(n.id);
    }
    return path;
  }

  /** <html> and <body> ids, for default expansion */
  find(tag: string): number | undefined {
    for (const n of this.nodes.values()) if (n.t === 'el' && n.tag === tag) return n.id;
    return undefined;
  }

  private build(n: SnapshotNode, parent: number | null): number {
    // Never let a node be its own parent, whatever the page sent.
    const node: DomNode = { id: n.id, t: n.t, attrs: {}, children: [], parent: parent === n.id ? null : parent };
    if (n.t === 'el') {
      node.tag = n.tag;
      node.attrs = { ...n.attrs };
      delete node.attrs['data-bsc-value'];
      delete node.attrs['data-bsc-checked'];
      this.nodes.set(n.id, node);
      node.children = n.children.map((c) => this.build(c, n.id));
      return n.id;
    }
    node.text = n.t === 'doctype' ? n.name : n.text;
    this.nodes.set(n.id, node);
    return n.id;
  }

  private forget(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const c of n.children) this.forget(c);
    this.nodes.delete(id);
  }
}

const models = new Map<string, DomModel>();

/** Drop a deleted session's DOM, which can be the largest thing we hold. */
export function dropDomModel(sessionId: string): void {
  models.delete(sessionId);
}

export function domModel(sessionId: string): DomModel {
  let m = models.get(sessionId);
  if (!m) {
    m = new DomModel();
    models.set(sessionId, m);
  }
  return m;
}

interface DomVersionStore {
  versions: Record<string, number>;
  bump(sessionId: string): void;
}
export const useDomVersions = create<DomVersionStore>((set) => ({
  versions: {},
  bump: (sessionId) => set((s) => ({ versions: { ...s.versions, [sessionId]: (s.versions[sessionId] ?? 0) + 1 } })),
}));

/** Enough of a node to tell it from whatever else inherits its id after a reload. */
function signatureOf(n: DomNode | undefined): string | null {
  if (!n) return null;
  return `${n.t}|${n.tag ?? ''}|${n.attrs['id'] ?? ''}|${n.attrs['class'] ?? ''}`;
}

/** Feed a screen event into the session's model; returns true when the tree changed. */
export function applyScreenEvent(sessionId: string, event: ScreenEvent): void {
  const m = domModel(sessionId);
  if (event.type === 'screen.snapshot') {
    /*
     * A reload starts the id counter over, so the same number comes back on a
     * different node and a selection made before it would quietly point at an
     * unrelated element — with the Styles pane describing that one. Note what
     * the selection looked like before the snapshot and keep it only if the
     * node now wearing the id is recognisably the same.
     */
    const sel = useElementsSelection.getState();
    const watching = sel.sessionId === sessionId && sel.id !== null ? sel.id : null;
    const before = watching === null ? null : signatureOf(m.get(watching));
    m.load(event.doc);
    if (watching !== null && before !== null && signatureOf(m.get(watching)) !== before) {
      useElementsSelection.getState().select(sessionId, null);
    }
    useDomVersions.getState().bump(sessionId);
  } else if (event.type === 'screen.mutations') {
    if (m.apply(event.ops)) useDomVersions.getState().bump(sessionId);
  }
}
