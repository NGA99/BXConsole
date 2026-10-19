/**
 * The Elements tree: rows for element open tags, text, comments and closing
 * tags, expanded on demand. Double-click an attribute to edit it, the tag
 * name to add one, a text node to edit it; Delete removes the node.
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { domModel, useDomVersions, type DomNode } from '../../state/dom-model';
import { domRemoveNode, domSetAttribute, domSetText, domScrollIntoView, domStoreGlobal } from '../../transport/client';
import { sessionData } from '../../state/session-data';
import { openContextMenu } from '../../devtools-ui/menu-store';
import { copyText } from '../network/copy';
import { parseAttributeEdit } from './attr-edit';

interface Row {
  id: number;
  depth: number;
  kind: 'open' | 'close' | 'text' | 'comment' | 'doctype';
}

interface Editing {
  id: number;
  what: 'attr' | 'new-attr' | 'text';
  name?: string;
  value: string;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ROW_H = 18;
const OVERSCAN = 20;

export const DomTree = memo(DomTreeImpl);

function DomTreeImpl({
  sessionId,
  selected,
  onSelect,
  onHover,
}: {
  sessionId: string;
  selected: number | null;
  onSelect: (id: number | null) => void;
  onHover: (id: number | null) => void;
}) {
  const version = useDomVersions((s) => s.versions[sessionId] ?? 0);
  const model = domModel(sessionId);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seenGeneration = useRef(0);
  // Windowed rendering: big pages have tens of thousands of rows; only the visible slice becomes DOM.
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  // Every snapshot (first load, page reload) brings new ids: open <html> and <body> again like DevTools.
  useEffect(() => {
    if (!model.loaded || model.generation === seenGeneration.current) return;
    seenGeneration.current = model.generation;
    const next = new Set<number>();
    for (const tag of ['html', 'body']) {
      const id = model.find(tag);
      if (id !== undefined) next.add(id);
    }
    setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Reveal the selection (e.g. picked from the Screen pane) by expanding its ancestors.
  useEffect(() => {
    if (selected === null || !model.get(selected)) return;
    const path = model.pathTo(selected);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of path.slice(0, -1)) next.add(id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);


  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (id: number, depth: number) => {
      const n = model.get(id);
      if (!n) return;
      if (n.t === 'tx') {
        if (n.text && n.text.trim()) out.push({ id, depth, kind: 'text' });
        return;
      }
      if (n.t === 'cm') return void out.push({ id, depth, kind: 'comment' });
      if (n.t === 'doctype') return void out.push({ id, depth, kind: 'doctype' });
      out.push({ id, depth, kind: 'open' });
      if (expanded.has(id) && n.children.length) {
        for (const c of n.children) walk(c, depth + 1);
        if (!VOID.has(n.tag ?? '')) out.push({ id, depth, kind: 'close' });
      }
    };
    for (const r of model.roots) walk(r, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, expanded, model]);

  // Once the rows include the selection (after ancestors expanded), bring it into view.
  useEffect(() => {
    const el = containerRef.current;
    if (selected === null || !el) return;
    const idx = rows.findIndex((r) => r.id === selected && r.kind !== 'close');
    if (idx < 0) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, rows]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || selected === null) return;
    const idx = rows.findIndex((r) => r.id === selected && r.kind !== 'close');
    const n = model.get(selected);
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = rows.slice(idx + 1).find((r) => r.kind !== 'close');
        if (next) onSelect(next.id);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = rows.slice(0, Math.max(0, idx)).reverse().find((r) => r.kind !== 'close');
        if (prev) onSelect(prev.id);
        break;
      }
      case 'ArrowRight':
        e.preventDefault();
        if (n?.children.length && !expanded.has(selected)) toggle(selected);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (expanded.has(selected)) toggle(selected);
        else if (n?.parent !== null && n?.parent !== undefined) onSelect(n.parent);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        domRemoveNode(sessionId, selected);
        break;
    }
  };

  const onContextMenu = (e: MouseEvent, id: number) => {
    e.preventDefault();
    onSelect(id);
    const n = model.get(id);
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Add attribute', disabled: n?.t !== 'el', onClick: () => setEditing({ id, what: 'new-attr', value: '' }) },
      { label: 'Edit text', disabled: n?.t !== 'tx' && n?.t !== 'cm', onClick: () => setEditing({ id, what: 'text', value: n?.text ?? '' }) },
      { separator: true },
      {
        label: 'Expand recursively',
        disabled: !n?.children.length,
        onClick: () => setExpanded((prev) => new Set([...prev, ...model.descendants(id)])),
      },
      { label: 'Collapse children', disabled: !n?.children.length, onClick: () => setExpanded((prev) => {
              // One walk and a Set: the old form walked the subtree once per
              // expanded id and scanned the result, which froze large pages.
              const gone = new Set(model.descendants(id));
              gone.delete(id);
              return new Set([...prev].filter((x) => !gone.has(x)));
            }) },
      { separator: true },
      {
        label: 'Store as global variable',
        disabled: n?.t !== 'el',
        onClick: () =>
          void domStoreGlobal(sessionId, id).then((varName) => {
            if (!varName) return;
            const store = sessionData(sessionId).getState();
            store.pushLocal({ type: 'eval.command', ts: Date.now(), expression: varName });
            store.pushLocal({
              type: 'eval.result',
              ts: Date.now(),
              result: { t: 'node', nodeType: 1, nodeName: (n?.tag ?? 'div').toUpperCase(), attrs: n?.attrs ?? {}, preview: outerHtml(model, id).slice(0, 200) },
            });
          }),
      },
      { label: 'Scroll into view', onClick: () => domScrollIntoView(sessionId, id) },
      { label: 'Copy selector', onClick: () => void copyText(selectorPath(model.pathTo(id).map((p) => model.get(p)!))) },
      { label: 'Copy outerHTML', onClick: () => void copyText(outerHtml(model, id)) },
      { separator: true },
      { label: 'Delete element', onClick: () => domRemoveNode(sessionId, id) },
    ]);
  };

  const commitEdit = () => {
    if (!editing) return;
    const { id, what, name, value } = editing;
    if (what === 'attr' && name) domSetAttribute(sessionId, id, name, value);
    else if (what === 'new-attr') {
      const edit = parseAttributeEdit(value);
      if (edit) domSetAttribute(sessionId, id, edit.name, edit.value);
    } else if (what === 'text') domSetText(sessionId, id, value);
    setEditing(null);
  };

  const editor = (ed: Editing) => (
    <input
      className="dom-edit mono"
      autoFocus
      /*
       * The rows are virtualised, so scrolling the edited row out of view
       * unmounts this input while it has focus. Focus then falls to <body>
       * and the tree's own key handler stops firing: arrows, Enter and Delete
       * all go dead until the user clicks the tree again. Take focus back --
       * only from <body>, so a click into another pane is left alone.
       */
      ref={(el) => {
        if (el || document.activeElement !== document.body) return;
        containerRef.current?.focus();
      }}
      value={ed.value}
      placeholder={ed.what === 'new-attr' ? 'name="value"' : undefined}
      onChange={(e) => setEditing({ ...ed, value: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitEdit();
        else if (e.key === 'Escape') setEditing(null);
        e.stopPropagation();
      }}
      onBlur={commitEdit}
      onClick={(e) => e.stopPropagation()}
    />
  );

  if (!model.loaded) return <div className="dom-empty">Waiting for the DOM snapshot… (the session must be connected)</div>;

  const first = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_H) + OVERSCAN);
  const slice = rows.slice(first, last);

  return (
    <div className="dom-tree mono" ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} onMouseLeave={() => onHover(null)}>
      <div style={{ height: first * ROW_H }} />
      {slice.map((row) => {
        const n = model.get(row.id)!;
        const isSel = row.id === selected;
        const base = `dom-row${isSel ? ' selected' : ''}`;
        const style = { paddingLeft: 8 + row.depth * 12 };
        const common = {
          'data-id': row.id,
          style,
          onClick: () => onSelect(row.id),
          onMouseEnter: () => onHover(row.id),
          onContextMenu: (e: MouseEvent) => onContextMenu(e, row.id),
        };
        if (row.kind === 'close') {
          return (
            <div key={`${row.id}-c`} className={base} {...common}>
              <span className="dom-arrow hidden" />
              <span className="tok-tag">&lt;/{n.tag}&gt;</span>
            </div>
          );
        }
        if (row.kind === 'text') {
          return (
            <div key={row.id} className={base} {...common} onDoubleClick={() => setEditing({ id: row.id, what: 'text', value: n.text ?? '' })}>
              <span className="dom-arrow hidden" />
              {editing?.id === row.id && editing.what === 'text' ? editor(editing) : <span className="dom-text">"{truncate(n.text ?? '')}"</span>}
            </div>
          );
        }
        if (row.kind === 'comment') {
          return (
            <div key={row.id} className={`${base} dom-comment`} {...common}>
              <span className="dom-arrow hidden" />
              &lt;!--{truncate(n.text ?? '')}--&gt;
            </div>
          );
        }
        if (row.kind === 'doctype') {
          return (
            <div key={row.id} className={`${base} dom-comment`} {...common}>
              <span className="dom-arrow hidden" />
              &lt;!DOCTYPE {n.text}&gt;
            </div>
          );
        }
        const hasChildren = n.children.some((c) => {
          const ch = model.get(c);
          return ch && (ch.t !== 'tx' || (ch.text && ch.text.trim()));
        });
        const open = expanded.has(row.id);
        const onlyText = !open && n.children.length === 1 && model.get(n.children[0]!)?.t === 'tx';
        return (
          <div key={row.id} className={base} {...common}>
            <span
              className={`dom-arrow${open ? ' open' : ''}${hasChildren ? '' : ' hidden'}`}
              title="Click to toggle, ⌥-click to expand recursively"
              onClick={(e) => {
                e.stopPropagation();
                if (e.altKey) setExpanded((prev) => new Set([...prev, ...model.descendants(row.id)]));
                else toggle(row.id);
              }}
            />
            <span className="tok-tag">&lt;</span>
            <span className="tok-tag dom-tagname" onDoubleClick={() => setEditing({ id: row.id, what: 'new-attr', value: '' })}>
              {n.tag}
            </span>
            {Object.entries(n.attrs).map(([k, v]) => (
              <span key={k} className="dom-attr" onDoubleClick={(e) => { e.stopPropagation(); setEditing({ id: row.id, what: 'attr', name: k, value: v }); }}>
                {' '}
                <span className="tok-attribute">{k}</span>
                {editing?.id === row.id && editing.what === 'attr' && editing.name === k ? (
                  <>=&quot;{editor(editing)}&quot;</>
                ) : (
                  <>
                    =<span className="tok-attribute-value">"{truncate(v, 80)}"</span>
                  </>
                )}
              </span>
            ))}
            {editing?.id === row.id && editing.what === 'new-attr' && <> {editor(editing)}</>}
            <span className="tok-tag">&gt;</span>
            {onlyText && <span className="dom-text">{truncate(model.get(n.children[0]!)?.text ?? '', 60)}</span>}
            {onlyText && <span className="tok-tag">&lt;/{n.tag}&gt;</span>}
            {!onlyText && !open && hasChildren && (
              <span className="dom-ellipsis" onClick={(e) => { e.stopPropagation(); toggle(row.id); }}>
                …
                <span className="tok-tag">&lt;/{n.tag}&gt;</span>
              </span>
            )}
            {!onlyText && !open && !hasChildren && !VOID.has(n.tag ?? '') && <span className="tok-tag">&lt;/{n.tag}&gt;</span>}
            {isSel && <span className="dom-dollar0"> == $0</span>}
          </div>
        );
      })}
      <div style={{ height: Math.max(0, rows.length - last) * ROW_H }} />
    </div>
  );
}

function truncate(s: string, n = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function selectorPath(path: DomNode[]): string {
  return path
    .filter((n) => n.t === 'el')
    .map((n) => {
      if (n.attrs.id) return `#${n.attrs.id}`;
      const cls = n.attrs.class ? '.' + n.attrs.class.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${n.tag}${cls}`;
    })
    .join(' > ');
}

export function outerHtml(model: { get(id: number): DomNode | undefined }, id: number): string {
  const n = model.get(id);
  if (!n) return '';
  if (n.t === 'tx') return n.text ?? '';
  if (n.t === 'cm') return `<!--${n.text ?? ''}-->`;
  if (n.t === 'doctype') return `<!DOCTYPE ${n.text ?? 'html'}>`;
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
    .join('');
  const inner = n.children.map((c) => outerHtml(model, c)).join('');
  return VOID.has(n.tag ?? '') ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}
