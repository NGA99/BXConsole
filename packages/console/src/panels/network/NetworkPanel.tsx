/**
 * Network tab, modelled on Chrome's.
 *
 *   row 1   ● record · ⊘ clear · filter toggle · search · Preserve log · Disable cache · ⚙
 *   row 2   Filter box (DevTools syntax) · Invert · More filters ▾ · type chips (⌘-click for several)
 *   row 3   ⚙: Big request rows · Show overview
 *   overview  bars per request, DCL/Load markers, drag to select a time range
 *   grid    DataGrid (right-click a row for Copy / Replay / Block / HAR; right-click the header for columns)
 *   drawer  RequestDetail
 *   status  requests · transferred · resources · Finish · DOMContentLoaded · Load
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionData, type NetworkEntry } from '../../state/session-data';
import { useSessionsStore } from '../../state/sessions';
import { usePromptInbox } from '../../state/prompt-inbox';
import { evaluate, sendNetworkConfigure } from '../../transport/client';
import { navigate } from '../../app/router';
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarInput } from '../../devtools-ui/Toolbar';
import { DataGrid, type Column, type SortState } from '../../devtools-ui/DataGrid';
import { SplitView } from '../../devtools-ui/SplitView';
import { ContextMenu, type MenuState } from '../../devtools-ui/ContextMenu';
import { RequestDetail } from './RequestDetail';
import { WaterfallCell, WaterfallHeader } from './Waterfall';
import { Overview } from './Overview';
import { TypeIcon } from './icons';
import { GearIcon } from '../../devtools-ui/icons';
import { compileFilter, hostOf } from './filters';
import { searchEntries } from './search';
import { NetworkSearch } from './NetworkSearch';
import { BODY_ORDER, LABEL, TITLE, bodyState, bodyTitle } from './body-state';
import { loadAll } from './stored-bodies';
import { asCurl, asFetch, copyText, replayExpression } from './copy';
import { toHar, downloadJson } from './har';
import { parseStack, shortLocation } from '../console/stack';
import { SourceLink } from '../../devtools-ui/SourceLink';
import { isLinkableUrl } from '../../devtools-ui/safe-url';
import { textOf } from './field-guard';
import { openSource } from '../../state/sources-target';
import { useNetworkSelection } from '../../state/network-selection';
import {
  TYPE_CHIPS,
  classify,
  durationOf,
  formatBytes,
  formatMs,
  nameOf,
  sizeLabel,
  statusLabel,
  statusTitle,
  timeLabel,
  typeLabel,
  type TypeChip,
  streamsFrames,
} from './classify';
import { rangeOf, timelineOf } from './timing';
import { useActiveTab } from '../../state/active-tab';
import { clockTimeShort, fullTimestamp } from '../../devtools-ui/time';
import './NetworkPanel.css';

type OptionalColumn = 'method' | 'domain' | 'path' | 'url' | 'start';
const OPTIONAL_COLUMNS: Array<{ id: OptionalColumn; title: string }> = [
  { id: 'method', title: 'Method' },
  { id: 'domain', title: 'Domain' },
  { id: 'path', title: 'Path' },
  { id: 'url', title: 'URL' },
  { id: 'start', title: 'Start Time' },
];

interface Settings {
  bigRows: boolean;
  overview: boolean;
  columns: OptionalColumn[];
}
const SETTINGS_KEY = 'bxconsole.network.settings';
function loadSettings(): Settings {
  try {
    return { bigRows: false, overview: true, columns: [], ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { bigRows: false, overview: true, columns: [] };
  }
}

interface MoreFilters {
  hideDataUrls: boolean;
  thirdParty: boolean;
  failedOnly: boolean;
}

export function NetworkPanel({ sessionId }: { sessionId: string }) {
  const store = sessionData(sessionId);
  const allEntries = store((s) => s.network);
  // Scoped to the window the tab strip points at, like the Console tab.
  const activeTab = useActiveTab(sessionId);
  const entries = useMemo(
    () => (activeTab ? allEntries.filter((e) => e.tabId === undefined || e.tabId === activeTab) : allEntries),
    [allEntries, activeTab],
  );
  const preserveLog = store((s) => s.preserveLog);
  const recording = store((s) => s.networkRecording);
  const disableCache = store((s) => s.disableCache);
  const blocked = store((s) => s.blockedPatterns);
  const timingByTab = store((s) => s.pageTimingByTab);
  const sessionTiming = store((s) => s.pageTiming);
  // The load markers belong to the window being shown, not to the session.
  const pageTiming = activeTab ? (timingByTab[activeTab] ?? {}) : sessionTiming;
  const session = useSessionsStore((s) => s.byId[sessionId]);
  // Whether a missing body can still be re-read from the page at all.
  const connected = session?.connected ?? false;
  // What the relay says it is holding, so every row can answer at once
  // instead of only the one that happens to be open.
  const keptFiles = store((s) => s.keptFiles);

  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const setSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(true);
  const [filter, setFilter] = useState('');
  const [invert, setInvert] = useState(false);
  const [chips, setChips] = useState<Set<TypeChip['id']>>(() => new Set(['all']));
  const [more, setMore] = useState<MoreFilters>({ hideDataUrls: false, thirdParty: false, failedOnly: false });
  const [moreOpen, setMoreOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const [timeRange, setTimeRange] = useState<{ min: number; max: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  /*
   * ⌘F / Ctrl+F opens the search, the way it does in DevTools.
   *
   * It used to focus the filter box instead, which is a different tool for a
   * different question: the filter decides which rows are listed, the search
   * looks inside them — headers, payloads, response bodies, websocket
   * messages. Someone pressing Find is asking the second question, and
   * answering with the first one quietly hid every match that was in a body.
   *
   * Handled here rather than in the shell's own shortcut table because this
   * panel is the one that knows it has a second place to look.
   */
  const focusWanted = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' || !(e.metaKey || e.ctrlKey)) return;
      /*
       * Only when this panel is the one on screen.
       *
       * The panels stay mounted behind a `hidden` attribute so a tab switch
       * keeps their state, which means a listener on the window hears every
       * key whichever tab is showing — Find on the Console tab was opening
       * the Network search behind it. `offsetParent` is null for anything
       * hidden, which is the question being asked.
       */
      if (!rootRef.current?.offsetParent) return;
      e.preventDefault();
      focusWanted.current = true;
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * The caret goes in after the field exists, which is a render later.
   *
   * Doing it from the key handler — even inside requestAnimationFrame — put
   * it there before React had committed the newly opened panel, so the search
   * opened and the typing went nowhere.
   */
  useEffect(() => {
    if (!searchOpen || !focusWanted.current) return;
    focusWanted.current = false;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [searchOpen]);

  // "Reveal in Network" from the Console: select that request.
  const reveal = useNetworkSelection();
  useEffect(() => {
    if (reveal.sessionId === sessionId && reveal.requestId) setSelected(reveal.requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.nonce]);

  // Drawer beside the grid when wide, under it when narrow (like Chrome).
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setNarrow(el.clientWidth < 760);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [search, setSearch] = useState('');
  const [searchOpts, setSearchOpts] = useState({ regex: false, caseSensitive: false });

  // Re-render once a second while something is pending so waterfall bars grow.
  const [, tick] = useState(0);
  // A live WebSocket never "finishes", so counting it as pending would re-render
  // the whole grid once a second for as long as the socket is open.
  const pending = entries.some((e) => !e.finished && !e.failed && !e.resource && !streamsFrames(e));
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [pending]);

  const sessionHost = hostOf(session?.url ?? '');
  const visible = useMemo(() => {
    const text = compileFilter(filter, invert);
    const matchers = Array.from(chips, (id) => TYPE_CHIPS.find((c) => c.id === id)?.matches ?? (() => false));
    return entries.filter((e) => {
      const type = classify(e);
      if (!matchers.some((m) => m(type))) return false;
      if (more.hideDataUrls && e.request.url.startsWith('data:')) return false;
      if (more.thirdParty && hostOf(e.request.url) === sessionHost) return false;
      if (more.failedOnly && !e.failed && (e.response?.status ?? 0) < 400) return false;
      if (timeRange && settings.overview) {
        const t = timelineOf(e);
        const end = t.end ?? Date.now();
        if (end < timeRange.min || t.start > timeRange.max) return false;
      }
      return text(e);
    });
  }, [entries, chips, filter, invert, more, timeRange, sessionHost, settings.overview]);

  // Time origin is navigation start when the agent reported it, like DevTools.
  const origin = pageTiming.navigationStart;
  const fullRange = useMemo(() => rangeOf(entries, origin), [entries, origin]);
  const range = useMemo(() => rangeOf(visible, origin), [visible, origin]);
  // From `visible`, not `entries`: a drawer describing a row the filter hides
  // leaves the grid with no highlight and collapsed to a single column.
  const current = selected ? visible.find((e) => e.requestId === selected) ?? null : null;
  useEffect(() => {
    if (selected && !current) setSelected(null);
  }, [selected, current]);

  // Bumped once stored bodies arrive, so the same query runs again over more
  // than it could see the first time.
  const [bodiesLoaded, setBodiesLoaded] = useState(0);
  const [loadingBodies, setLoadingBodies] = useState(false);
  const { hits, unloaded } = useMemo(
    () => (searchOpen ? searchEntries(entries, search, searchOpts) : { hits: [], unloaded: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, search, searchOpts, searchOpen, bodiesLoaded],
  );
  const searchStoredBodies = () => {
    setLoadingBodies(true);
    void loadAll(sessionId, unloaded).finally(() => {
      setLoadingBodies(false);
      setBodiesLoaded((n) => n + 1);
    });
  };

  // ---------------------------------------------------------------- columns
  const columns = useMemo<Column<NetworkEntry>[]>(() => {
    const big = settings.bigRows;
    const name: Column<NetworkEntry> = {
      id: 'name',
      title: 'Name',
      width: 220,
      render: (e) => (
        <>
          <span className="cell-name" title={e.request.url}>
            <TypeIcon type={classify(e)} failed={Boolean(e.failed)} />
            <span>{nameOf(e.request.url)}</span>
          </span>
          {big && <span className="cell-sub">{pathOf(e.request.url)}</span>}
        </>
      ),
      sortValue: (e) => nameOf(e.request.url),
    };
    if (current) return [name];

    const optional: Column<NetworkEntry>[] = settings.columns.map((id) => {
      switch (id) {
        case 'method':
          return { id, title: 'Method', width: 70, render: (e) => e.request.method, sortValue: (e) => e.request.method };
        case 'domain':
          return { id, title: 'Domain', width: 140, render: (e) => hostOf(e.request.url), sortValue: (e) => hostOf(e.request.url) };
        case 'path':
          return { id, title: 'Path', width: 160, render: (e) => pathOf(e.request.url), sortValue: (e) => pathOf(e.request.url) };
        case 'start':
          // "Time" is how long the request took; this is when it started, on the wall clock.
          return {
            id,
            // "Started" rather than "Start Time": the header truncates next to "Status" otherwise.
            // Seconds are enough in the column; the tooltip carries the date and milliseconds.
            title: 'Started',
            width: 84,
            render: (e) => <span title={fullTimestamp(e.request.ts)}>{clockTimeShort(e.request.ts)}</span>,
            sortValue: (e) => e.request.ts,
          };
        default:
          return { id, title: 'URL', width: 260, render: (e) => e.request.url, sortValue: (e) => e.request.url };
      }
    });

    return [
      name,
      ...optional,
      {
        id: 'status',
        title: 'Status',
        width: 90,
        // The same floor the Body column needs, for the same reason: fixed
        // columns are scaled down when they do not all fit, and a status that
        // is not a number was the first to go — "(opaque)" came out
        // "(opaqu…", which reads as a word nobody can check. Measured at the
        // grid's 11px monospace: "(opaque)" and "(failed)" are 53px, and the
        // cell adds 6px of padding on each side.
        minWidth: 65,
        render: (e) => (
          <span title={statusTitle(e)} className={statusLabel(e) === '—' || statusLabel(e) === '(opaque)' ? 'status-unknown' : undefined}>
            {statusLabel(e)}
            {e.failed && <span className="error-detail"> {e.failed.error}</span>}
          </span>
        ),
        sortValue: (e) => e.response?.status ?? e.resource?.responseStatus ?? (e.failed ? -1 : 999),
      },
      { id: 'type', title: 'Type', width: 90, render: typeLabel, sortValue: typeLabel },
      { id: 'initiator', title: 'Initiator', width: 120, render: (e) => <InitiatorCell entry={e} />, sortValue: initiatorLabel },
      {
        id: 'body',
        title: 'Body',
        width: 96,
        // The grid scales fixed columns down when they do not all fit, and
        // without a floor "Captured" became "Capt". Measured: the longest
        // badge needs 67px, plus the cell's own 12px of padding.
        minWidth: 84,
        render: (e) => {
          const state = bodyState(e, keptFiles, connected);
          return (
            <span className={`body-state ${state}`} title={bodyTitle(e, state)}>
              {LABEL[state]}
            </span>
          );
        },
        sortValue: (e) => BODY_ORDER[bodyState(e, keptFiles, connected)],
      },
      {
        id: 'size',
        title: 'Size',
        width: 80,
        align: 'right',
        // "58.5 kB" came out "58.5 …", which is a number with its unit cut
        // off. The widest this column ever shows is one step below the next
        // unit — "1023.9 kB" — at 60px, plus the cell's 12px of padding.
        minWidth: 72,
        render: (e) => (
          <>
            <span>{sizeLabel(e).text}</span>
            {big && <span className="cell-sub">{resourceSize(e)}</span>}
          </>
        ),
        sortValue: (e) => sizeLabel(e).bytes,
      },
      // Its longest readings, "Pending" and "1.3 min", are both 47px wide;
      // without a floor of its own it would be the next column to lose its
      // tail once the two beside it stopped giving ground.
      { id: 'time', title: 'Time', width: 80, minWidth: 59, align: 'right', render: timeLabel, sortValue: (e) => durationOf(e) ?? Infinity },
      {
        id: 'waterfall',
        title: 'Waterfall',
        width: 200,
        header: <WaterfallHeader range={range} />,
        render: (e) => <WaterfallCell entry={e} range={range} />,
        sortValue: (e) => e.request.ts,
      },
    ];
  }, [current, range, settings.bigRows, settings.columns, keptFiles, connected]);

  // ------------------------------------------------------------------ menus
  const openHeaderMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...OPTIONAL_COLUMNS.map((c) => ({
          label: c.title,
          checked: settings.columns.includes(c.id),
          onClick: () =>
            setSettings({
              columns: settings.columns.includes(c.id) ? settings.columns.filter((x) => x !== c.id) : [...settings.columns, c.id],
            }),
        })),
        { separator: true },
        { label: 'Reset columns', onClick: () => setSettings({ columns: [] }) },
      ],
    });
  };

  const openRowMenu = (entry: NetworkEntry, e: React.MouseEvent) => {
    const replayable = entry.request.kind === 'fetch' || entry.request.kind === 'xhr';
    // Not entry.request.url.split: the page reported it, so it is a string
    // only by type, and this one feeds the blocked-pattern list.
    const pattern = textOf(entry.request.url).split('?')[0]!;
    const isBlocked = blocked.includes(pattern);
    const setBlocked = (list: string[]) => {
      store.getState().setBlockedPatterns(list);
      sendNetworkConfigure(sessionId, { blocked: list });
    };
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open in Sources', disabled: streamsFrames(entry), onClick: () => openSource(sessionId, entry.request.url) },
        // Greyed out rather than guarded at click time: `window.open` on a
        // `javascript:` URL runs it in a window that inherits this origin, and
        // the URL is whatever the page reported for the request.
        {
          label: 'Open in new tab',
          disabled: !isLinkableUrl(entry.request.url),
          onClick: () => window.open(entry.request.url, '_blank'),
        },
        { separator: true },
        { label: 'Copy URL', onClick: () => void copyText(entry.request.url) },
        { label: 'Copy as cURL', onClick: () => void copyText(asCurl(entry)) },
        { label: 'Copy as fetch', onClick: () => void copyText(asFetch(entry)) },
        {
          label: 'Copy response',
          disabled: entry.response?.body == null && entry.response?.bodyRef == null,
          onClick: () => void copyResponseBody(sessionId, entry),
        },
        { separator: true },
        { label: 'Replay XHR', disabled: !replayable, onClick: () => void evaluate(sessionId, replayExpression(entry)) },
        {
          label: 'Edit and resend',
          disabled: !replayable,
          onClick: () => {
            usePromptInbox.getState().set(asFetch(entry));
            navigate({ panel: 'console', sessionId });
          },
        },
        { separator: true },
        isBlocked
          ? { label: 'Unblock request URL', onClick: () => setBlocked(blocked.filter((p) => p !== pattern)) }
          : { label: 'Block request URL', onClick: () => setBlocked([...blocked, pattern]) },
        { separator: true },
        { label: 'Copy all as HAR', onClick: () => void har().then((h) => copyText(JSON.stringify(h, null, 2))) },
        { label: 'Save all as HAR', onClick: () => void har().then((h) => downloadJson(h, `${sessionHost || 'session'}.har`)) },
      ],
    });
  };
  const har = () => toHar(entries, { title: session?.title ?? '', url: session?.url ?? '', sessionId });

  const toggleChip = (id: TypeChip['id'], multi: boolean) => {
    setChips((prev) => {
      if (id === 'all' || !multi) return new Set([id]);
      const next = new Set(prev);
      next.delete('all');
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size ? next : new Set(['all']);
    });
  };

  const stats = useMemo(() => {
    let transferred = 0;
    let resources = 0;
    for (const e of visible) {
      transferred += sizeLabel(e).bytes;
      resources += bodySize(e) ?? 0;
    }
    return { transferred, resources, finish: range.max - range.min };
  }, [visible, range]);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <SplitView
      sideOn="start"
      initialSide={320}
      minSide={220}
      minMain={320}
      storageKey="bxconsole.network.search"
      side={
        searchOpen ? (
          <NetworkSearch
            query={search}
            onQuery={setSearch}
            opts={searchOpts}
            onOpts={setSearchOpts}
            result={{ hits, unloaded }}
            entries={entries}
            loadingBodies={loadingBodies}
            onSearchStored={searchStoredBodies}
            onPick={setSelected}
            onClose={() => setSearchOpen(false)}
            inputRef={searchInput}
          />
        ) : null
      }
      main={
    <div className="network-root" ref={rootRef}>
      <Toolbar>
        <ToolbarButton title={recording ? 'Stop recording network log' : 'Record network log'} onClick={() => store.getState().setNetworkRecording(!recording)}>
          <span className={`record-dot${recording ? ' on' : ''}`} />
        </ToolbarButton>
        <ToolbarButton
          title="Clear"
          onClick={() => {
            // Drop the range too: new requests fall outside the old window and
            // the panel would look dead with no visible cause.
            setTimeRange(null);
            store.getState().clearNetwork();
          }}
        >
          <ClearIcon />
        </ToolbarButton>
        <ToolbarButton title="Filter" onClick={() => setFilterOpen((o) => !o)}>
          <FunnelIcon active={filterOpen} />
        </ToolbarButton>
        <ToolbarButton title="Search" onClick={() => setSearchOpen((o) => !o)}>
          <SearchIcon active={searchOpen} />
        </ToolbarButton>
        <ToolbarDivider />
        <label className="toolbar-check">
          <input type="checkbox" checked={preserveLog} onChange={(e) => store.getState().setPreserveLog(e.target.checked)} /> Preserve log
        </label>
        <label className="toolbar-check" title="fetch/XHR only: requests are sent with cache: no-store">
          <input
            type="checkbox"
            checked={disableCache}
            onChange={(e) => {
              store.getState().setDisableCache(e.target.checked);
              sendNetworkConfigure(sessionId, { disableCache: e.target.checked });
            }}
          />{' '}
          Disable cache
        </label>
        {blocked.length > 0 && (
          <>
            <ToolbarDivider />
            <button
              className="toolbar-button network-blocked"
              title={`Blocked:\n${blocked.join('\n')}\n\nClick to unblock all`}
              onClick={() => {
                store.getState().setBlockedPatterns([]);
                sendNetworkConfigure(sessionId, { blocked: [] });
              }}
            >
              ⊘ {blocked.length} blocked
            </button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <ToolbarButton title="Network settings" onClick={() => setSettingsOpen((o) => !o)}>
          <GearIcon active={settingsOpen} />
        </ToolbarButton>
      </Toolbar>

      {filterOpen && (
        <Toolbar>
          <div className="network-filter">
            <FunnelIcon />
            <input className="network-filter-input" data-find="" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
          </div>
          <label className="toolbar-check">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Invert
          </label>
          <ToolbarDivider />
          <div className="network-more">
            <button className="toolbar-button" onClick={() => setMoreOpen((o) => !o)}>
              More filters ▾
            </button>
            {moreOpen && (
              <div className="network-more-popup" onMouseLeave={() => setMoreOpen(false)}>
                <label>
                  <input type="checkbox" checked={more.hideDataUrls} onChange={(e) => setMore({ ...more, hideDataUrls: e.target.checked })} /> Hide data URLs
                </label>
                <label>
                  <input type="checkbox" checked={more.thirdParty} onChange={(e) => setMore({ ...more, thirdParty: e.target.checked })} /> 3rd-party requests
                </label>
                <label>
                  <input type="checkbox" checked={more.failedOnly} onChange={(e) => setMore({ ...more, failedOnly: e.target.checked })} /> Blocked / failed requests
                </label>
              </div>
            )}
          </div>
        </Toolbar>
      )}
      {filterOpen && (
        <Toolbar>
          <div className="network-chips" title="⌘/Ctrl-click to select several">
            {TYPE_CHIPS.map((c) => (
              <button
                key={c.id}
                className={`network-chip${chips.has(c.id) ? ' selected' : ''}`}
                onClick={(e) => toggleChip(c.id, e.metaKey || e.ctrlKey)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </Toolbar>
      )}

      {settingsOpen && (
        <div className="network-settings-grid">
          <label className="toolbar-check">
            <input type="checkbox" checked={settings.bigRows} onChange={(e) => setSettings({ bigRows: e.target.checked })} /> Big request rows
          </label>
          <label className="toolbar-check disabled" title="Not available: frames are not observable from the page script">
            <input type="checkbox" disabled /> Group by frame
          </label>
          <label className="toolbar-check">
            <input type="checkbox" checked={settings.overview} onChange={(e) => setSettings({ overview: e.target.checked })} /> Overview
          </label>
          <label className="toolbar-check disabled" title="Not available: use the Screen tab for a live view">
            <input type="checkbox" disabled /> Screenshots
          </label>
        </div>
      )}

      {settings.overview && entries.length > 0 && (
        <Overview entries={entries} range={fullRange} timing={pageTiming} selection={timeRange} onSelect={setTimeRange} />
      )}

      <SplitView
        direction={narrow ? 'vertical' : 'horizontal'}
        main={
          entries.length === 0 ? (
            <div className="network-empty">
              {recording ? 'Recording network activity… Perform a request in the page or reload it to see requests here.' : 'Not recording.'}
            </div>
          ) : (
            <DataGrid
              columns={columns}
              rows={visible}
              rowKey={(e) => e.requestId}
              selectedKey={selected}
              onSelect={(key) => setSelected(key)}
              rowClassName={(e) => {
                if (e.failed || (e.response?.status ?? 0) >= 400 || (e.resource?.responseStatus ?? 0) >= 400) return 'error';
                if (!e.finished && !e.failed && !e.resource) return 'pending';
                // Only an outright loss is worth tinting the whole row: a body
                // that could have been read and no longer can. The other four
                // states say what they are in the Body column and leave the
                // row alone, or half a recording would be painted red.
                return bodyState(e, keptFiles, connected) === 'lost' ? 'body-lost' : '';
              }}
              sort={sort}
              onSortChange={setSort}
              onRowContextMenu={openRowMenu}
              onHeaderContextMenu={openHeaderMenu}
              rowHeight={settings.bigRows ? 'big' : 'normal'}
            />
          )
        }
        side={current ? <RequestDetail entry={current} sessionId={sessionId} onClose={() => setSelected(null)} /> : null}
        initialSide={narrow ? 320 : 480}
        minSide={160}
        storageKey={narrow ? 'bxconsole.network.drawer.v' : 'bxconsole.network.drawer.h'}
      />

      <div className="network-status">
        <span>{visible.length === entries.length ? `${entries.length} requests` : `${visible.length} / ${entries.length} requests`}</span>
        <span>{formatBytes(stats.transferred)} transferred</span>
        <span>{formatBytes(stats.resources)} resources</span>
        <span>Finish: {formatMs(stats.finish)}</span>
        {pageTiming.domContentLoaded && <span className="status-dcl">DOMContentLoaded: {formatMs(pageTiming.domContentLoaded - fullRange.min)}</span>}
        {pageTiming.load && <span className="status-load">Load: {formatMs(pageTiming.load - fullRange.min)}</span>}
      </div>

      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
      }
    />
  );
}

// ------------------------------------------------------------------- cells

function InitiatorCell({ entry }: { entry: NetworkEntry }) {
  const top = parseStack(entry.request.stack)[0];
  if (top) {
    return (
      <SourceLink className="initiator-link" url={top.url} line={top.line} col={top.col} title={entry.request.stack}>
        {shortLocation(top)}
      </SourceLink>
    );
  }
  return <span title={entry.request.initiator}>{initiatorLabel(entry)}</span>;
}

function initiatorLabel(e: NetworkEntry): string {
  const top = parseStack(e.request.stack)[0];
  if (top) return shortLocation(top);
  if (e.resource) return e.resource.initiatorType === 'navigation' ? 'Other' : 'Parser';
  return 'Script';
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The body, from the line or from the store, whichever holds it. */
async function copyResponseBody(sessionId: string, entry: NetworkEntry): Promise<void> {
  const res = entry.response;
  if (res?.body != null) return copyText(res.body);
  if (!res?.bodyRef) return;
  try {
    const got = await fetch(`/body/${sessionId}/${res.bodyRef}`);
    if (got.ok) await copyText(await got.text());
  } catch {
    /* the sweep took it, or the relay is gone: nothing to copy */
  }
}

function resourceSize(e: NetworkEntry): string {
  const n = bodySize(e);
  return n === undefined ? '' : formatBytes(n);
}

/**
 * How much came back, wherever the body ended up.
 *
 * A recorded run keeps big bodies in the blob store and the event keeps only
 * their size, so measuring `body.length` alone would show nothing for exactly
 * the responses big enough to be worth seeing.
 */
function bodySize(e: NetworkEntry): number | undefined {
  return e.resource?.decodedBodySize ?? e.response?.bodyBytes ?? e.response?.body?.length;
}

function FunnelIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${active ? ' active' : ''}`}>
      <path
        d="M2 3h12l-4.6 5.6V13l-2.8 1.2V8.6z"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${active ? ' active' : ''}`}>
      <circle cx="6.8" cy="6.8" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.2 10.2L14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.2 3.2l7.6 7.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
