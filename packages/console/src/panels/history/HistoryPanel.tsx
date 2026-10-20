/**
 * History tab.
 *
 *   toolbar    clear · filter · lane toggles · zoom reset · selection readout
 *   timeline   one lane per kind of event, drawn on a shared time axis;
 *              wheel to zoom, drag to select a range
 *   list       every event in time order, newest last; click to inspect,
 *              ↗ to reveal the same event in Console or Network, ⟲ to rewind
 *              the Screen mirror to that moment (DOM time travel)
 *
 * The lanes read the session's existing console and network buffers, so the
 * timeline agrees with those tabs by construction. Interactions, marks, DOM
 * density and performance observations come from the History recording the
 * agent installs in the page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { sessionData } from '../../state/session-data';
import { useSessionsStore } from '../../state/sessions';
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarInput } from '../../devtools-ui/Toolbar';
import { revealRequest } from '../../state/network-selection';
import { revealConsole } from '../../state/console-selection';
import { revealScreenAt, useScreenReplay } from '../../state/screen-replay';
import { RewindToIcon, RevealIcon } from '../../devtools-ui/icons';
import { buildItems, LANES, type HistItem, type LaneId } from './items';
import { clockTime, clockTimeShort, fullTimestamp, friendlyTimestamp } from '../../devtools-ui/time';
import { setActiveTab, useActiveTab } from '../../state/active-tab';
import { niceTimeStep } from '../../devtools-ui/scale';
import './HistoryPanel.css';

const LANES_KEY = 'bxconsole.history.lanes';
const CLOCK_KEY = 'bxconsole.history.clock';
const MIN_SPAN = 50;
const MAX_ROWS = 2000;
/** beyond this the session opens on its last minute instead of its whole length */
const LONG_SESSION = 180_000;
const RECENT_SPAN = 60_000;

type LaneFlags = Record<LaneId, boolean>;

function defaultLanes(): LaneFlags {
  return Object.fromEntries(LANES.map((l) => [l.id, l.defaultOn])) as LaneFlags;
}
function loadLanes(): LaneFlags {
  try {
    const raw = localStorage.getItem(LANES_KEY);
    return raw ? { ...defaultLanes(), ...(JSON.parse(raw) as Partial<LaneFlags>) } : defaultLanes();
  } catch {
    return defaultLanes();
  }
}

export function HistoryPanel({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  const store = sessionData(sessionId);
  const data = store(
    useShallow((s) => ({ history: s.history, console: s.console, network: s.network, pageTiming: s.pageTiming, timingByTab: s.pageTimingByTab })),
  );
  const connected = useSessionsStore((s) => s.byId[sessionId]?.connected ?? false);

  // History can span every window of the run or stay on the one the strip
  // points at; the column says which window a row came from either way.
  const tabs = useSessionsStore((s) => s.byId[sessionId]?.tabs) ?? [];
  const tabLabel = useMemo(() => {
    const m = new Map<string, string>();
    tabs.forEach((t, i) => m.set(t.tabId, `${i + 1}`));
    return m;
  }, [tabs]);
  const tabTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tabs) m.set(t.tabId, t.title || t.url);
    return m;
  }, [tabs]);
  const multiTab = tabs.length > 1;
  const activeTab = useActiveTab(sessionId);
  /*
   * One window at a time by default, like every other panel.
   *
   * Spanning the whole run is the more useful answer often enough to keep —
   * a flow that crosses windows is one story, and reading it in three lists
   * loses the order. It just should not be the only answer: a run with three
   * windows put two windows of noise between every pair of rows that mattered.
   */
  const [wholeRun, setWholeRun] = useState(false);

  // Panels stay mounted and are only hidden, and this walks every console,
  // network and history entry and sorts the result. Doing that for each
  // incoming event while you are on another tab makes typing stutter.
  const items = useMemo(
    () => (active ? buildItems({ history: data.history, console: data.console, network: data.network, timingByTab: data.timingByTab, pageTiming: data.pageTiming }) : []),
    [active, data.history, data.console, data.network, data.pageTiming, data.timingByTab],
  );

  const [lanes, setLanes] = useState<LaneFlags>(loadLanes);
  const toggleLane = (id: LaneId) => {
    const next = { ...lanes, [id]: !lanes[id] };
    setLanes(next);
    try {
      localStorage.setItem(LANES_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  // Wall-clock by default: an offset only says how long after the recording started,
  // which is rarely the question. The toggle still gives you offsets when you want them.
  const [clock, setClock] = useState(() => {
    try {
      return localStorage.getItem(CLOCK_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggleClock = () => {
    const next = !clock;
    setClock(next);
    try {
      localStorage.setItem(CLOCK_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  /** 'fit' shows the whole session, 'recent' follows the last minute, 'custom' is whatever you zoomed to. */
  const [mode, setMode] = useState<'fit' | 'recent' | 'custom'>('fit');
  const [customView, setCustomView] = useState<{ start: number; end: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // While the page is live the axis keeps growing; tick so "now" stays the right edge.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!connected || !active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [connected, active]);

  const bounds = useMemo(() => {
    if (items.length === 0) {
      const now = Date.now();
      return { start: now - 1000, end: now };
    }
    const start = items[0]!.ts;
    let end = start;
    for (const i of items) end = Math.max(end, i.ts + (i.durationMs ?? 0));
    if (connected) end = Math.max(end, Date.now());
    return { start, end: Math.max(end, start + MIN_SPAN) };
  }, [items, connected]);

  // A session that has been open for hours opens on its last minute; a short one opens whole.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || items.length === 0) return;
    initialised.current = true;
    if (bounds.end - bounds.start > LONG_SESSION) setMode('recent');
  }, [items.length, bounds]);

  // "Recent" follows the clock while the page is busy, but anchors to the last thing that
  // happened once it goes quiet, so an idle session never shows an empty window.
  const recentWindow = useMemo(() => {
    const last = items.length ? items[items.length - 1]!.ts : bounds.end;
    if (bounds.end - last > RECENT_SPAN) {
      return { start: Math.max(bounds.start, last - RECENT_SPAN * 0.9), end: last + RECENT_SPAN * 0.1 };
    }
    return { start: Math.max(bounds.start, bounds.end - RECENT_SPAN), end: bounds.end };
  }, [items, bounds]);

  // Fit and Recent pad their edges so a marker on the first or last event is not half-clipped;
  // a window the user zoomed to is left exactly as they set it.
  const window_ = useMemo(() => {
    if (mode === 'custom' && customView) return customView;
    const raw = mode === 'recent' ? recentWindow : bounds;
    const pad = Math.max((raw.end - raw.start) * 0.02, 1);
    return { start: raw.start - pad, end: raw.end + pad };
  }, [mode, customView, recentWindow, bounds]);
  const span = Math.max(window_.end - window_.start, MIN_SPAN);

  const visible = useMemo(() => {
    const byLane = items.filter((i) => lanes[i.lane]);
    if (wholeRun || !multiTab || !activeTab) return byLane;
    // Rows with no window are from a recording made before windows were
    // tracked; dropping them would empty the panel for every old run.
    return byLane.filter((i) => i.tabId === undefined || i.tabId === activeTab);
  }, [items, lanes, wholeRun, multiTab, activeTab]);

  const matched = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = visible;
    if (q) list = list.filter((i) => `${i.kind} ${i.label} ${i.detail ?? ''}`.toLowerCase().includes(q));
    if (selection) list = list.filter((i) => i.ts >= selection.start && i.ts <= selection.end);
    return list;
  }, [visible, filter, selection]);

  const counts = useMemo(() => {
    const c = {} as Record<LaneId, number>;
    for (const l of LANES) c[l.id] = 0;
    for (const i of items) c[i.lane]++;
    return c;
  }, [items]);

  // --------------------------------------------------------------- timeline

  const tracksRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  const tsAt = (clientX: number): number => {
    const el = tracksRef.current;
    if (!el) return window_.start;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(r.width, 1)));
    return window_.start + f * span;
  };
  const pct = (ts: number): number => ((ts - window_.start) / span) * 100;

  // React attaches wheel passively, so preventDefault there is ignored and the
  // surrounding panel scrolls while the axis rescales. Attach it directly.
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => onWheelRef.current(e);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onWheel = (e: { deltaY: number; clientX: number; preventDefault: () => void }) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    const focus = tsAt(e.clientX);
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    const nextSpan = Math.min(Math.max(span * factor, MIN_SPAN), bounds.end - bounds.start || MIN_SPAN);
    const ratio = (focus - window_.start) / span;
    let start = focus - ratio * nextSpan;
    let end = start + nextSpan;
    if (start < bounds.start) {
      start = bounds.start;
      end = start + nextSpan;
    }
    if (end > bounds.end) {
      end = bounds.end;
      start = end - nextSpan;
    }
    if (nextSpan >= bounds.end - bounds.start) {
      setMode('fit');
      setCustomView(null);
    } else {
      setMode('custom');
      setCustomView({ start, end });
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const from = tsAt(e.clientX);
    setDrag({ from, to: from });
    const move = (ev: MouseEvent) => setDrag({ from, to: tsAt(ev.clientX) });
    const up = (ev: MouseEvent) => {
      const to = tsAt(ev.clientX);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      setDrag(null);
      setSelection(hi - lo > span / 200 ? { start: lo, end: hi } : null);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  onWheelRef.current = onWheel;

  const band = drag ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) } : selection;

  // ------------------------------------------------------------------- list

  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [matched]);

  const rows = matched.length > MAX_ROWS ? matched.slice(-MAX_ROWS) : matched;
  const dropped = matched.length - rows.length;

  const reveal = (item: HistItem) => {
    if (!item.reveal) return;
    // Console and Network show one window; point them at this item's one first,
    // or the row we are revealing is filtered out and nothing happens.
    if (item.tabId) setActiveTab(sessionId, item.tabId);
    if (item.reveal.panel === 'network') revealRequest(sessionId, item.reveal.requestId);
    else revealConsole(sessionId, item.reveal.seq);
  };

  /** Where the Screen panel's replay stands, drawn as a line over the lanes. */
  const playhead = useScreenReplay((st) => (st.playhead?.sessionId === sessionId ? st.playhead.ts : null));
  /** The moment asked for, shown until the player reports its own position. */
  const [requestedTs, setRequestedTs] = useState<number | null>(null);
  const replaying = useScreenReplay((st) => st.playhead?.sessionId === sessionId);
  // Back to live clears the playhead; without dropping the request too, the
  // marker would fall back to it and keep claiming a replay that has ended.
  useEffect(() => {
    if (!replaying) setRequestedTs(null);
  }, [replaying]);
  const marker = playhead ?? requestedTs;

  /** Rewind the docked Screen mirror to a moment on this timeline. */
  const showScreenAt = (ts: number) => {
    setRequestedTs(ts);
    revealScreenAt(sessionId, ts);
  };

  const focusItem = (item: HistItem) => {
    setSelectedId(item.id);
    // Bring the marker into view if the user zoomed somewhere else.
    if (item.ts < window_.start || item.ts > window_.end) {
      const half = span / 2;
      setMode('custom');
      setCustomView({ start: item.ts - half, end: item.ts + half });
    }
  };

  const maxWeight = useMemo(() => {
    let m = 1;
    for (const i of items) if (i.lane === 'dom' && i.weight) m = Math.max(m, i.weight);
    return m;
  }, [items]);

  const activeLanes = LANES.filter((l) => lanes[l.id]);

  return (
    <>
      <Toolbar wrap>
        <ToolbarButton title="Clear history" onClick={() => store.getState().clearHistory()}>
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3.2 3.2l7.6 7.6" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarInput placeholder="Filter" value={filter} onChange={setFilter} find />
        <ToolbarDivider />
        <div className="hist-lane-chips">
          {LANES.map((l) => (
            <button
              key={l.id}
              className={`hist-chip${lanes[l.id] ? ' on' : ''}`}
              style={{ ['--chip-color' as string]: l.color }}
              title={`${l.label}: ${counts[l.id]} events`}
              onClick={() => toggleLane(l.id)}
            >
              <span className="hist-chip-dot" />
              {l.label}
              <span className="hist-chip-count">{counts[l.id]}</span>
            </button>
          ))}
          {multiTab && (
            <button
              className={`hist-chip${wholeRun ? ' on' : ''}`}
              title={
                wholeRun
                  ? 'Showing every window of the run. Click to show only the one the tab strip points at.'
                  : `Showing ${tabTitle.get(activeTab ?? '') ?? 'one window'}. Click to show every window of the run.`
              }
              onClick={() => setWholeRun((v) => !v)}
            >
              {wholeRun ? `All ${tabs.length} windows` : 'This window'}
            </button>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {/* Grouped so a wrap never splits the zoom pair across two rows. */}
        <span className="hist-button-group">
          <button
            className={`hist-text-button${mode === 'fit' ? ' on' : ''}`}
            onClick={() => {
              setMode('fit');
              setCustomView(null);
            }}
            title="Show the whole session"
          >
            Fit
          </button>
          <button
            className={`hist-text-button${mode === 'recent' ? ' on' : ''}`}
            onClick={() => {
              setMode('recent');
              setCustomView(null);
            }}
            title="Zoom to the most recent minute of activity"
          >
            Recent
          </button>
          {selection && (
            <button className="hist-text-button" onClick={() => setSelection(null)} title="Clear the selected range">
              Clear range
            </button>
          )}
          <button
            className={`hist-text-button${clock ? ' on' : ''}`}
            onClick={toggleClock}
            title={clock ? 'Show times as an offset from the first event' : 'Show wall-clock times'}
          >
            Clock
          </button>
        </span>
        <span className="hist-status">
          {selection
            ? `${formatDuration(selection.end - selection.start)} selected · ${matched.length} events`
            : `${matched.length} of ${items.length} events`}
        </span>
        {items.length > 0 && (
          <span className="hist-status hist-started" title={`The first recorded event, which every relative time counts from:\n${fullTimestamp(bounds.start)}`}>
            from {friendlyTimestamp(bounds.start)}
          </span>
        )}
      </Toolbar>

      <div className="hist-body">
        <div className="hist-timeline">
          <div className="hist-lane-labels">
            <div className="hist-ruler-label" />
            {activeLanes.map((l) => (
              <div key={l.id} className="hist-lane-label" title={`${l.label}: ${counts[l.id]} events`}>
                <span className="hist-lane-swatch" style={{ background: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
          <div className="hist-tracks" ref={tracksRef} onMouseDown={onMouseDown}>
            <Ruler
              start={window_.start}
              span={span}
              origin={bounds.start}
              clock={clock}
              onScrub={(clientX) => showScreenAt(tsAt(clientX))}
            />
            {activeLanes.map((l) => (
              <div key={l.id} className="hist-track">
                {visible
                  .filter((i) => i.lane === l.id && i.ts + (i.durationMs ?? 0) >= window_.start && i.ts <= window_.end)
                  .map((i) => {
                    const left = pct(i.ts);
                    const width = i.durationMs ? Math.max((i.durationMs / span) * 100, 0.4) : undefined;
                    const height = l.id === 'dom' && i.weight ? `${Math.max(18, Math.round((Math.log(i.weight + 1) / Math.log(maxWeight + 1)) * 100))}%` : undefined;
                    return (
                      <div
                        key={i.id}
                        className={`hist-marker lane-${l.id}${i.severity ? ` sev-${i.severity}` : ''}${selectedId === i.id ? ' selected' : ''}${width ? ' bar' : ''}`}
                        style={{ left: `${left}%`, ...(width ? { width: `${width}%` } : {}), ...(height ? { height } : {}) }}
                        title={`${fullTimestamp(i.ts)} · ${i.kind} · ${i.label}\n⌥-click: show the screen at this moment`}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          if (e.altKey) return showScreenAt(i.ts);
                          focusItem(i);
                          scrollListTo(listRef.current, i.id);
                        }}
                        onDoubleClick={() => reveal(i)}
                      />
                    );
                  })}
              </div>
            ))}
            {marker !== null && marker >= window_.start && marker <= window_.end && (
              <div className="hist-playhead" style={{ left: `${pct(marker)}%` }} title="Screen replay position" />
            )}
            {/* Replaying a moment outside the zoom: say so at the edge it lies
                past, rather than leaving the timeline looking uninvolved. */}
            {marker !== null && (marker < window_.start || marker > window_.end) && (
              <button
                className={`hist-playhead-edge ${marker < window_.start ? 'left' : 'right'}`}
                title="The Screen replay is outside this view — click to bring it here"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  const half = span / 2;
                  setMode('custom');
                  setCustomView({ start: marker - half, end: marker + half });
                }}
              >
                {marker < window_.start ? '◀' : '▶'}
              </button>
            )}
            {band && (
              <div
                className="hist-band"
                style={{ left: `${Math.max(0, pct(band.start))}%`, width: `${Math.min(100, pct(band.end)) - Math.max(0, pct(band.start))}%` }}
              />
            )}
          </div>
        </div>

        <div className="hist-list" ref={listRef} onScroll={() => {
          const el = listRef.current;
          if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}>
          {items.length === 0 && (
            <div className="hist-empty">
              Nothing recorded yet. Interact with the page, or call <code>window.__bxconsole.mark('name')</code> to drop a marker.
            </div>
          )}
          {items.length > 0 && rows.length === 0 && <div className="hist-empty">No events match the filter or the selected range.</div>}
          {dropped > 0 && <div className="hist-more">{dropped} earlier events not shown</div>}
          {rows.map((i) => (
            <div
              key={i.id}
              data-id={i.id}
              className={`hist-row lane-${i.lane}${i.severity ? ` sev-${i.severity}` : ''}${selectedId === i.id ? ' selected' : ''}`}
              title={[fullTimestamp(i.ts), i.label, i.detail].filter(Boolean).join('\n')}
              onClick={() => focusItem(i)}
              onDoubleClick={() => reveal(i)}
            >
              <span className="hist-row-time">{clock ? clockTime(i.ts) : timeOf(i.ts, bounds.start)}</span>
              {multiTab && (
                <span
                  className={`hist-row-tab${i.tabId ? '' : ' none'}`}
                  title={i.tabId ? `Window: ${tabTitle.get(i.tabId) ?? i.tabId}\nClick to point the other tabs at it` : 'Recorded before windows were tracked'}
                  onClick={(e) => {
                    if (!i.tabId) return;
                    e.stopPropagation();
                    setActiveTab(sessionId, i.tabId);
                  }}
                >
                  {i.tabId ? (tabLabel.get(i.tabId) ?? '?') : '–'}
                </span>
              )}
              <span className="hist-row-dot" style={{ background: laneColor(i.lane) }} />
              <span className="hist-row-kind">{i.kind}</span>
              <span className="hist-row-label">{i.label}</span>
              {i.detail && <span className="hist-row-detail">{i.detail}</span>}
              {i.durationMs !== undefined && <span className="hist-row-duration">{Math.round(i.durationMs)} ms</span>}
              <button
                className="hist-row-action"
                title="Show the screen at this moment"
                aria-label="Show the screen at this moment"
                onClick={(e) => {
                  e.stopPropagation();
                  showScreenAt(i.ts);
                }}
              >
                <RewindToIcon />
              </button>
              {/* Always rendered, disabled when this kind of event lives nowhere
                  else, so the actions line up in a column down the list. */}
              <button
                className="hist-row-action"
                disabled={!i.reveal}
                title={i.reveal ? (i.reveal.panel === 'network' ? 'Reveal in Network' : 'Reveal in Console') : 'Nothing to reveal: this event has no row in another panel'}
                aria-label={i.reveal ? (i.reveal.panel === 'network' ? 'Reveal in Network' : 'Reveal in Console') : 'Nothing to reveal'}
                onClick={(e) => {
                  e.stopPropagation();
                  reveal(i);
                }}
              >
                <RevealIcon />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function scrollListTo(list: HTMLDivElement | null, id: string): void {
  const el = list?.querySelector<HTMLElement>(`.hist-row[data-id="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

function laneColor(id: LaneId): string {
  return LANES.find((l) => l.id === id)?.color ?? 'var(--sys-color-token-subtle)';
}

/**
 * Ticks along the top of the tracks, labelled as time since the first event.
 * Pressing it scrubs the Screen mirror to that moment, instead of selecting a
 * range (which is what dragging the lanes below does).
 */
function Ruler({
  start,
  span,
  origin,
  clock,
  onScrub,
}: {
  start: number;
  span: number;
  origin: number;
  clock: boolean;
  onScrub: (clientX: number) => void;
}) {
  const step = niceTimeStep(span / 6);
  const first = Math.ceil((start - origin) / step) * step + origin;
  const ticks: number[] = [];
  for (let t = first; t <= start + span; t += step) ticks.push(t);
  return (
    <div
      className="hist-ruler"
      title="Click to show the screen at this moment"
      onMouseDown={(e) => {
        e.stopPropagation();
        onScrub(e.clientX);
        const move = (ev: MouseEvent) => onScrub(ev.clientX);
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      }}
    >
      {ticks.map((t) => (
        <span key={t} className="hist-tick" title={fullTimestamp(t)} style={{ left: `${((t - start) / span) * 100}%` }}>
          {clock ? clockTimeShort(t) : formatDuration(t - origin)}
        </span>
      ))}
    </div>
  );
}


function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function timeOf(ts: number, origin: number): string {
  const d = ts - origin;
  return d < 0 ? '0 ms' : formatDuration(d);
}
