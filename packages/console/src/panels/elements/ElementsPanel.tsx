/**
 * Elements tab: DOM tree on the left, Styles / Computed on the right, a
 * breadcrumb of the selection underneath. The tree is fed by the same
 * screen stream as the mirror; selecting or hovering a node outlines it in
 * the Screen pane. Mounted only while visible so streaming stops with it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementStyles } from '@bxconsole/protocol';
import { subscribeScreen, domGetStyles } from '../../transport/client';
import { applyScreenEvent, domModel, useDomVersions } from '../../state/dom-model';
import { useScreenHighlight } from '../../state/screen-highlight';
import { useElementsSelection } from '../../state/elements-selection';
import { useSessionsStore } from '../../state/sessions';
import { SplitView } from '../../devtools-ui/SplitView';
import { TabBar } from '../../devtools-ui/TabBar';
import { DomTree, selectorPath } from './DomTree';
import { Toolbar } from '../../devtools-ui/Toolbar';
import { StylesPane } from './StylesPane';
import { ComputedPane } from './ComputedPane';
import './ElementsPanel.css';

type SideTab = 'styles' | 'computed';

export function ElementsPanel({ sessionId }: { sessionId: string }) {
  const connected = useSessionsStore((s) => s.byId[sessionId]?.connected ?? false);
  const version = useDomVersions((s) => s.versions[sessionId] ?? 0);
  const selection = useElementsSelection();
  const selected = selection.sessionId === sessionId ? selection.id : null;
  const [tab, setTab] = useState<SideTab>('styles');
  const [styles, setStyles] = useState<ElementStyles | null>(null);
  const model = domModel(sessionId);

  // Find in the tree: string match on tag / attributes / text, Enter cycles, like Chrome's Elements search.
  // Debounced and capped: on big pages a full-tree scan per keystroke (and per mutation) is too much.
  const [find, setFind] = useState('');
  const [findIdx, setFindIdx] = useState(-1);
  const [findMatches, setFindMatches] = useState<number[]>([]);
  useEffect(() => {
    const q = find.trim();
    if (!q) return void setFindMatches([]);
    const timer = setTimeout(() => setFindMatches(model.search(q).slice(0, 2000)), 200);
    return () => clearTimeout(timer);
  }, [find, model]);
  const jumpFind = (dir: 1 | -1) => {
    if (!findMatches.length) return;
    const next = (findIdx + dir + findMatches.length) % findMatches.length;
    setFindIdx(next);
    select(findMatches[next]!);
  };

  // Like DevTools: side-by-side when wide, Styles under the tree when narrow.
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setNarrow(el.clientWidth < 720);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the DOM model fed while this tab is open.
  useEffect(() => subscribeScreen(sessionId, (ev) => applyScreenEvent(sessionId, ev)), [sessionId]);

  // Like Chrome: the Screen outline follows the tree row under the pointer and flashes briefly on
  // selection; it never stays on, so the Screen pane does not look like inspect mode.
  const flashTimer = useRef<number | null>(null);
  const outline = (id: number | null) => {
    const n = id === null ? undefined : model.get(id);
    useScreenHighlight.getState().set(id, n ? labelOf(n.tag, n.attrs) : '');
  };
  const select = useCallback(
    (id: number | null) => {
      useElementsSelection.getState().select(sessionId, id);
      outline(id);
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => outline(null), 1200);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );
  const hover = useCallback((id: number | null) => outline(id), []); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * Styles for the selection, on two paths on purpose.
   *
   * Picking a node asks at once. Keeping up with the page is a throttle, not a
   * debounce: a page that mutates faster than the delay (an animation, a
   * ticker, a chart) used to reset the timer forever and the pane stayed empty
   * for as long as the page was alive. A throttle still fires under that load,
   * one request per window at most.
   */
  const stylesReq = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  // What a queued refresh should ask for, read when it fires rather than closed over.
  const target = useRef<{ sessionId: string; id: number | null }>({ sessionId, id: selected });
  target.current = { sessionId, id: selected };

  const loadStyles = useCallback(() => {
    const { sessionId: sid, id } = target.current;
    if (id === null || domModel(sid).get(id)?.t !== 'el') return;
    const token = ++stylesReq.current;
    void domGetStyles(sid, id).then((s) => {
      // Only the newest request may paint: an earlier one landing late would
      // otherwise put the previous element's styles on screen.
      if (stylesReq.current === token) setStyles(s);
    });
  }, []);

  useEffect(() => {
    if (selected === null || !connected || model.get(selected)?.t !== 'el') {
      stylesReq.current++; // nothing in flight may paint over the cleared pane
      setStyles(null);
      return;
    }
    loadStyles();
  }, [selected, sessionId, connected, model, loadStyles]);

  useEffect(() => {
    if (selected === null || !connected || refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      loadStyles();
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    },
    [],
  );

  // A selection made elsewhere (inspect pick in the Screen pane) flashes too; clear on unmount.
  useEffect(() => {
    if (selected !== null) {
      outline(selected);
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => outline(null), 1200);
    }
    return () => useScreenHighlight.getState().set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Drop a selection whose node disappeared.
  useEffect(() => {
    if (selected !== null && model.loaded && !model.get(selected)) select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const path = selected === null ? [] : model.pathTo(selected).map((id) => model.get(id)!).filter((n) => n.t === 'el');

  return (
    <div className="elements-root" ref={rootRef}>
    <SplitView
      direction={narrow ? 'vertical' : 'horizontal'}
      main={
        <div className="elements-main">
          <Toolbar>
            <input
              className="field toolbar-input"
              data-find=""
              placeholder="Find by string, tag, id or class"
              value={find}
              onChange={(e) => {
                setFind(e.target.value);
                setFindIdx(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jumpFind(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') setFind('');
              }}
            />
            {find && (
              <span className="detail-note">
                {/* findIdx starts at -1, so a fresh query would read "0 of N". */}
                {findMatches.length ? `${findIdx < 0 ? 1 : findIdx + 1} of ${findMatches.length}` : 'no matches'}
              </span>
            )}
          </Toolbar>
          <DomTree sessionId={sessionId} selected={selected} onSelect={select} onHover={hover} />
          <div className="elements-crumbs mono">
            {path.length === 0 && <span className="detail-note">{connected ? 'Select a node' : 'Session offline: showing the last known tree'}</span>}
            {path.map((n) => (
              <span key={n.id} className={`elements-crumb${n.id === selected ? ' current' : ''}`} onClick={() => select(n.id)} title={selectorPath([n])}>
                {labelOf(n.tag, n.attrs)}
              </span>
            ))}
          </div>
        </div>
      }
      side={
        <div className="elements-side">
          <TabBar
            tabs={[
              { id: 'styles' as const, label: 'Styles' },
              { id: 'computed' as const, label: 'Computed' },
            ]}
            active={tab}
            onSelect={setTab}
          />
          {tab === 'styles' ? <StylesPane styles={styles} onSelectAncestor={select} /> : <ComputedPane styles={styles} />}
        </div>
      }
      initialSide={narrow ? 300 : 360}
      minSide={160}
      storageKey={narrow ? 'bxconsole.elements.side.v' : 'bxconsole.elements.side.h'}
    />
    </div>
  );
}

function labelOf(tag: string | undefined, attrs: Record<string, string>): string {
  const id = attrs.id ? `#${attrs.id}` : '';
  const cls = attrs.class ? '.' + attrs.class.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
  return `${tag ?? ''}${id}${cls}`;
}
