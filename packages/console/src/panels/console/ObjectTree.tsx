/**
 * DevTools-style expandable value tree.
 *
 * Collapsed: one-line preview (`▸ {a: 1, b: {…}}`). Expanded: children come
 * from the shallow preview immediately, then are replaced by the full
 * property list fetched from the agent (`object.getProperties`), which ends
 * with [[Prototype]]. Getters show `(...)` and are evaluated on click.
 * Right-click offers "Store object as global variable" and "Copy object".
 * DOM nodes highlight themselves in the Screen mirror on hover and scroll
 * into view on click.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { PropertyPreview, SerializedValue } from '@bxconsole/protocol';
import { getProperties, invokeGetter, storeAsGlobal, objectJson, locateNode, scrollNodeIntoView } from '../../transport/client';
import { openContextMenu } from '../../devtools-ui/menu-store';
import { useScreenHighlight } from '../../state/screen-highlight';
import { useElementsSelection } from '../../state/elements-selection';
import { navigate } from '../../app/router';
import { sessionData } from '../../state/session-data';
import { copyText } from '../network/copy';
import { formatValue, isCompound } from './format';
import './ObjectTree.css';
import { downloadText, stampedName } from '../../devtools-ui/download';

const propsCache = new Map<string, PropertyPreview[] | null>();
const LONG_STRING = 500;

export function ObjectTree({
  value,
  sessionId,
  name,
  expanded: initiallyExpanded = false,
  topLevel = false,
}: {
  value: SerializedValue;
  sessionId: string;
  name?: string;
  expanded?: boolean;
  topLevel?: boolean;
}) {
  if (!isCompound(value)) {
    return (
      <span className="otree-leaf">
        {name !== undefined && <PropName name={name} />}
        {value.t === 'string' && value.v.length > LONG_STRING ? (
          <LongString value={value} mode={topLevel ? 'top' : 'nested'} />
        ) : (
          <Inline value={value} mode={topLevel ? 'top' : 'nested'} />
        )}
      </span>
    );
  }
  return (
    <CompoundNode value={value} sessionId={sessionId} name={name} initiallyExpanded={initiallyExpanded} />
  );
}

function CompoundNode({
  value,
  sessionId,
  name,
  initiallyExpanded,
}: {
  value: SerializedValue;
  sessionId: string;
  name?: string;
  initiallyExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const id = 'id' in value ? value.id : undefined;
  const [fetched, setFetched] = useState<PropertyPreview[] | null | undefined>(id ? propsCache.get(id) : undefined);
  const [loading, setLoading] = useState(false);
  const [evaluated, setEvaluated] = useState<Record<string, SerializedValue>>({});

  useEffect(() => {
    if (!expanded || !id || fetched !== undefined || loading) return;
    setLoading(true);
    void getProperties(sessionId, id).then((props) => {
      propsCache.set(id, props);
      setFetched(props);
      setLoading(false);
    });
  }, [expanded, id, fetched, loading, sessionId]);

  const children = expanded ? childrenOf(value, fetched) : [];
  const canExpand = id !== undefined || previewChildren(value).length > 0 || value.t === 'error';

  const onContextMenu = (e: MouseEvent) => {
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Store object as global variable',
        onClick: () =>
          void storeAsGlobal(sessionId, id).then((varName) => {
            if (!varName) return;
            const store = sessionData(sessionId).getState();
            store.pushLocal({ type: 'eval.command', ts: Date.now(), expression: varName });
            store.pushLocal({ type: 'eval.result', ts: Date.now(), result: value });
          }),
      },
      { label: 'Copy object', onClick: () => void objectJson(sessionId, id).then((text) => copyText(text ?? formatValue(value, 'preview'))) },
      { label: 'Copy preview', onClick: () => void copyText(formatValue(value, 'preview')) },
      ...(value.t === 'node'
        ? [
            { separator: true },
            {
              label: 'Reveal in Elements panel',
              onClick: () =>
                void locateNode(sessionId, id).then((screenId) => {
                  if (screenId === null) return;
                  useElementsSelection.getState().select(sessionId, screenId);
                  navigate({ panel: 'elements', sessionId });
                }),
            },
            { label: 'Scroll into view', onClick: () => scrollNodeIntoView(sessionId, id) },
          ]
        : []),
    ]);
  };

  const nodeHover = value.t === 'node' && id ? { onMouseEnter: () => void highlightNode(sessionId, id, value), onMouseLeave: () => useScreenHighlight.getState().set(null) } : {};

  return (
    <div className="otree-node">
      <div
        className={`otree-line${canExpand ? ' expandable' : ''}${value.t === 'node' ? ' is-node' : ''}`}
        onClick={() => canExpand && setExpanded((e) => !e)}
        onContextMenu={onContextMenu}
        onDoubleClick={value.t === 'node' && id ? () => scrollNodeIntoView(sessionId, id) : undefined}
        {...nodeHover}
      >
        <span className={`otree-arrow${expanded ? ' open' : ''}${canExpand ? '' : ' hidden'}`} />
        {name !== undefined && <PropName name={name} dim={name === '[[Prototype]]'} />}
        <Inline value={value} mode="preview" />
      </div>
      {expanded && (
        <div className="otree-children">
          {value.t === 'error' && value.stack && <pre className="otree-stack">{value.stack}</pre>}
          {value.t === 'error' && value.cause && (
            <div className="otree-child">
              <ObjectTree value={value.cause} sessionId={sessionId} name="Caused by" />
            </div>
          )}
          {children.map((p) => (
            <div key={p.name} className={`otree-child${p.enumerable === false ? ' non-enumerable' : ''}`}>
              {p.getter && !evaluated[p.name] ? (
                <span className="otree-leaf">
                  <PropName name={p.name} />
                  <button
                    className="otree-getter"
                    title="Invoke property getter"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!id) return;
                      void invokeGetter(sessionId, id, p.name).then((v) => v && setEvaluated((m) => ({ ...m, [p.name]: v })));
                    }}
                  >
                    (...)
                  </button>
                </span>
              ) : (
                <ObjectTree value={evaluated[p.name] ?? p.value} sessionId={sessionId} name={p.name} />
              )}
            </div>
          ))}
          {loading && <div className="otree-note">loading…</div>}
          {!loading && id && fetched === null && (
            <div className="otree-note">object no longer available (session offline or collected)</div>
          )}
          {!loading && children.length === 0 && fetched !== null && <div className="otree-note">no properties</div>}
        </div>
      )}
    </div>
  );
}

async function highlightNode(sessionId: string, objectId: string, value: Extract<SerializedValue, { t: 'node' }>): Promise<void> {
  const screenId = await locateNode(sessionId, objectId);
  const label = `${value.nodeName.toLowerCase()}${value.attrs?.id ? `#${value.attrs.id}` : ''}`;
  useScreenHighlight.getState().set(screenId, label);
}

function childrenOf(value: SerializedValue, fetched: PropertyPreview[] | null | undefined): PropertyPreview[] {
  if (fetched) return sortProps(fetched);
  return previewChildren(value);
}

function previewChildren(value: SerializedValue): PropertyPreview[] {
  switch (value.t) {
    case 'object':
      return value.preview;
    case 'array':
      return [
        ...value.preview.map((v, i) => ({ name: String(i), value: v })),
        { name: 'length', value: { t: 'number' as const, v: value.length }, enumerable: false },
      ];
    case 'map':
      return value.preview.map(([k, v], i) => ({
        name: `${i}`,
        value: { t: 'object' as const, className: 'Entry', preview: [{ name: 'key', value: k }, { name: 'value', value: v }] },
      }));
    case 'set':
      return value.preview.map((v, i) => ({ name: String(i), value: v }));
    case 'error':
      return [
        { name: 'message', value: { t: 'string', v: value.message } },
        ...(value.stack ? [{ name: 'stack', value: { t: 'string' as const, v: value.stack } }] : []),
      ];
    default:
      return [];
  }
}

function sortProps(props: PropertyPreview[]): PropertyPreview[] {
  // numeric keys first in numeric order, then alphabetical, [[Prototype]] last, like DevTools
  return [...props].sort((a, b) => {
    const ap = a.name.startsWith('[[');
    const bp = b.name.startsWith('[[');
    if (ap !== bp) return ap ? 1 : -1;
    const an = /^\d+$/.test(a.name);
    const bn = /^\d+$/.test(b.name);
    if (an && bn) return Number(a.name) - Number(b.name);
    if (an) return -1;
    if (bn) return 1;
    return a.name.localeCompare(b.name);
  });
}

function PropName({ name, dim = false }: { name: string; dim?: boolean }) {
  return (
    <>
      <span className={`tok tok-property${dim ? ' tok-meta' : ''}`}>{name}</span>
      <span className="tok tok-punct">: </span>
    </>
  );
}

/**
 * Past this, reading it in a console row is not the point any more and a file
 * is. Below it, Show more and a selection do the job.
 */
const DOWNLOADABLE = 4 * 1024;

/**
 * What the Show more button says.
 *
 * Two different losses, and the reader has to be able to tell them apart: the
 * console folded a long string away, which a click undoes, and the agent cut
 * one short in the page, which nothing undoes. Saying "10,000 chars" for a
 * string that was 20,000 reads as the whole of it, so when the original length
 * came through it is the one quoted, with how much of it is actually here.
 */
function moreLabel(value: Extract<SerializedValue, { t: 'string' }>): string {
  const here = value.v.length;
  if (!value.truncated) return `Show more (${here.toLocaleString()} chars)`;
  if (typeof value.length === 'number' && value.length > here) {
    return `Show more (${here.toLocaleString()} of ${value.length.toLocaleString()} chars — the rest never left the page)`;
  }
  return `Show more (${here.toLocaleString()} chars, truncated by agent)`;
}

/**
 * Strings over LONG_STRING characters collapse with a Show more toggle.
 *
 * Collapsed, the cut is by height as well as by character count, and the
 * height is what the reader feels. A character count cannot be fair to both
 * alphabets: 500 characters is five or six lines of English and twenty-five
 * of Korean or Chinese in the same column, so one long log line was burying
 * everything around it in exactly the places this tool is pointed at. The
 * slice still bounds what goes into the DOM; the clamp decides what is seen.
 */
function LongString({ value, mode }: { value: Extract<SerializedValue, { t: 'string' }>; mode: 'top' | 'nested' }) {
  const [open, setOpen] = useState(false);
  const text = open ? value.v : value.v.slice(0, LONG_STRING);
  return (
    <span className={mode === 'top' ? 'tok' : 'tok tok-string'}>
      {open ? (
        <>
          {mode === 'top' ? text : `'${text}'`}
        </>
      ) : (
        <span className="otree-str-clamp">
          {mode === 'top' ? text : `'${text}`}
          {'…'}
        </span>
      )}
      <button className="otree-more" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        {open ? 'Show less' : moreLabel(value)}
      </button>
      {/* What arrived is already here, so the file is made from memory and
          the relay is not asked for anything. A string the agent had to cut
          saves what there is of it — which the name says, so a half string
          does not get filed away as the whole one. */}
      {value.v.length >= DOWNLOADABLE && (
        <button
          className="otree-more"
          title={value.truncated ? 'Save the part that reached the console' : 'Save the whole string as a file'}
          onClick={(e) => {
            e.stopPropagation();
            downloadText(value.v, stampedName(value.truncated ? 'console-value-partial' : 'console-value', 'txt', value.v.length));
          }}
        >
          {value.truncated ? 'Download what arrived' : 'Download'}
        </button>
      )}
    </span>
  );
}

// ----------------------------------------------------------------- inline rendering

/** Syntax-coloured one-line rendering of a value. */
export function Inline({ value, mode }: { value: SerializedValue; mode: 'top' | 'preview' | 'nested' }): ReactNode {
  switch (value.t) {
    case 'string':
      return <span className={mode === 'top' ? 'tok' : 'tok tok-string'}>{formatValue(value, mode)}</span>;
    case 'number':
    case 'bigint':
    case 'boolean':
      return <span className="tok tok-number">{formatValue(value, mode)}</span>;
    case 'undefined':
    case 'null':
      return <span className="tok tok-meta">{formatValue(value, mode)}</span>;
    case 'symbol':
      return <span className="tok tok-string">{value.v}</span>;
    case 'regexp':
      return <span className="tok tok-regexp">{value.v}</span>;
    case 'date':
      return <span className="tok">{value.v}</span>;
    case 'function':
      return (
        <span className="tok tok-function">
          <span className="tok-italic">ƒ </span>
          {mode === 'nested' ? '' : `${value.name}()`}
        </span>
      );
    case 'error':
      return <span className="tok tok-error">{mode === 'nested' ? `${value.name}: ${value.message}` : firstLine(value.stack) ?? `${value.name}: ${value.message}`}</span>;
    case 'node':
      return <NodeInline value={value} mode={mode} />;
    case 'promise':
      return <span className="tok">Promise</span>;
    case 'circular':
      return <span className="tok tok-meta">[Circular]</span>;
    case 'getter':
      // Not called at log time; "Invoke property getter" on the row reads it.
      return <span className="tok tok-meta" title="Accessor: expand the row to read it">(...)</span>;
    case 'unserializable':
      return <span className="tok tok-meta">{value.description}</span>;
    case 'array':
      if (mode === 'nested') return <span className="tok tok-meta">Array({value.length})</span>;
      return (
        <span className="tok">
          <span className="tok-meta">({value.length}) </span>[
          {joinNodes(
            value.preview.map((v, i) => <Inline key={i} value={v} mode="nested" />),
            Boolean(value.truncated && value.preview.length < value.length),
          )}
          ]
        </span>
      );
    case 'object':
      if (mode === 'nested') return <span className="tok tok-meta">{value.className === 'Object' ? '{…}' : value.className}</span>;
      return (
        <span className="tok">
          {value.className !== 'Object' && <span className="tok-meta">{value.className} </span>}
          {'{'}
          {joinNodes(
            value.preview.map((p) => (
              <span key={p.name}>
                <span className="tok-property">{p.name}</span>: <Inline value={p.value} mode="nested" />
              </span>
            )),
            Boolean(value.truncated),
          )}
          {'}'}
        </span>
      );
    case 'map':
      if (mode === 'nested') return <span className="tok tok-meta">Map({value.size})</span>;
      return (
        <span className="tok">
          <span className="tok-meta">Map({value.size}) </span>
          {'{'}
          {joinNodes(
            value.preview.map(([k, v], i) => (
              <span key={i}>
                <Inline value={k} mode="nested" /> {'=>'} <Inline value={v} mode="nested" />
              </span>
            )),
            value.preview.length < value.size,
          )}
          {'}'}
        </span>
      );
    case 'set':
      if (mode === 'nested') return <span className="tok tok-meta">Set({value.size})</span>;
      return (
        <span className="tok">
          <span className="tok-meta">Set({value.size}) </span>
          {'{'}
          {joinNodes(
            value.preview.map((v, i) => <Inline key={i} value={v} mode="nested" />),
            value.preview.length < value.size,
          )}
          {'}'}
        </span>
      );
  }
}

function NodeInline({ value, mode }: { value: Extract<SerializedValue, { t: 'node' }>; mode: 'top' | 'preview' | 'nested' }) {
  if (value.nodeType !== 1) return <span className="tok tok-string">{mode === 'nested' ? `#${value.nodeName.toLowerCase().replace('#', '')}` : value.preview}</span>;
  const tag = value.nodeName.toLowerCase();
  // Inside a collection DevTools shows the CSS-selector form: button#save.primary
  if (mode === 'nested') return <span className="tok tok-tag">{selectorForm(tag, value.attrs)}</span>;
  return (
    <span className="tok tok-node">
      <span className="tok-tag">&lt;{tag}</span>
      {Object.entries(value.attrs ?? {}).map(([k, v]) => (
        <span key={k}>
          {' '}
          <span className="tok-attribute">{k}</span>=<span className="tok-attribute-value">"{v}"</span>
        </span>
      ))}
      <span className="tok-tag">&gt;…&lt;/{tag}&gt;</span>
    </span>
  );
}

function selectorForm(tag: string, attrs: Record<string, string> | undefined): string {
  const id = attrs?.id ? `#${attrs.id}` : '';
  const cls = attrs?.class ? attrs.class.trim().split(/\s+/).filter(Boolean).map((c) => `.${c}`).join('') : '';
  return `${tag}${id}${cls}`;
}

function joinNodes(nodes: ReactNode[], ellipsis: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((n, i) => {
    if (i) out.push(<span key={`s${i}`}>, </span>);
    out.push(n);
  });
  if (ellipsis) out.push(<span key="e">{nodes.length ? ', …' : '…'}</span>);
  return out;
}

function firstLine(s: string | undefined): string | undefined {
  return s?.split('\n')[0];
}
