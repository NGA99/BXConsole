/**
 * Console tab.
 *
 *   toolbar   clear · level dropdown · text filter · settings (timestamps, group similar)
 *   messages  grouped tree, repeat counts, expandable objects, stack traces, source links
 *   prompt    eval in the session, results interleaved like DevTools
 */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sessionData, entryTab, type ConsoleEntry } from '../../state/session-data';
import { useSessionsStore } from '../../state/sessions';
import { evaluate } from '../../transport/client';
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarInput } from '../../devtools-ui/Toolbar';
import { ContextMenu, type MenuState } from '../../devtools-ui/ContextMenu';
import { clockTime as formatTime, fullTimestamp } from '../../devtools-ui/time';
import { navigate } from '../../app/router';
import { SourceLink } from '../../devtools-ui/SourceLink';
import { revealRequest } from '../../state/network-selection';
import { useConsoleSelection } from '../../state/console-selection';
import { useActiveTab } from '../../state/active-tab';
import { copyText } from '../network/copy';
import { ObjectTree, Inline } from './ObjectTree';
import { LevelMenu } from './LevelMenu';
import { StackTrace } from './StackTrace';
import { TableView } from './TableView';
import { ConsolePrompt } from './ConsolePrompt';
import { GearIcon } from '../../devtools-ui/icons';
import { applyFormat } from './format-spec';
import { formatValue } from './format';
import { buildTree, filterTree, severityOf, rowText, DEFAULT_LEVELS, ALL_LEVELS, type LevelFilter, type Row, type Severity } from './group-tree';
import type { SerializedValue } from '@bxconsole/protocol';
import { parseStack, shortLocation } from './stack';
import './ConsolePanel.css';

interface Settings {
  timestamps: boolean;
  groupSimilar: boolean;
  /** hide the "GET url 404" rows derived from network events */
  hideNetwork: boolean;
  /** preview the prompt's value while typing (side-effect-free expressions only) */
  eagerEval: boolean;
}
const SETTINGS_KEY = 'bxconsole.console.settings';
function loadSettings(): Settings {
  const defaults: Settings = { timestamps: false, groupSimilar: true, hideNetwork: false, eagerEval: true };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return defaults;
  }
}

export function ConsolePanel({ sessionId }: { sessionId: string }) {
  const store = sessionData(sessionId);
  const allEntries = store((s) => s.console);
  // A session can hold several windows; show the one the tab strip points at.
  // Entries with no tab come from recordings made before windows were tracked.
  const activeTab = useActiveTab(sessionId);
  const entries = useMemo(
    () => (activeTab ? allEntries.filter((e) => entryTab(e) === undefined || entryTab(e) === activeTab) : allEntries),
    [allEntries, activeTab],
  );
  const connected = useSessionsStore((s) => s.byId[sessionId]?.connected ?? false);

  const [levels, setLevels] = useState<LevelFilter>(DEFAULT_LEVELS);
  const [filter, setFilter] = useState('');
  const preserveLog = store((s) => s.preserveLog);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const setSettings = (next: Settings) => {
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // ---- live expressions (the eye icon): evaluated every 500ms while open
  const liveKey = `bxconsole.live.${sessionId}`;
  const [liveOpen, setLiveOpen] = useState(false);
  const [live, setLiveState] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(liveKey) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const setLive = (list: string[]) => {
    setLiveState(list);
    try {
      localStorage.setItem(liveKey, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  };
  const [liveValues, setLiveValues] = useState<Record<string, SerializedValue | null>>({});
  const [liveDraft, setLiveDraft] = useState('');
  useEffect(() => {
    if (!liveOpen || !connected || live.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const next: Record<string, SerializedValue | null> = {};
      for (const expr of live) {
        const r = await evaluate(sessionId, expr);
        next[expr] = r.exception ?? r.result ?? null;
      }
      if (!cancelled) setLiveValues(next);
    };
    void tick();
    const id = setInterval(() => void tick(), 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveOpen, connected, live, sessionId]);

  // ---- sidebar: counts by level and by source, click to filter
  const [sidebarOpen, setSidebarOpen] = useState(false);
  type SidebarSel = { kind: 'all' } | { kind: 'user' } | { kind: 'level'; level: Severity } | { kind: 'source'; source: string };
  const [sidebarSel, setSidebarSel] = useState<SidebarSel>({ kind: 'all' });

  const base = useMemo(() => (settings.hideNetwork ? entries.filter((e) => e.type !== 'network.error') : entries), [entries, settings.hideNetwork]);
  const sidebar = useMemo(() => {
    const counts = { all: 0, user: 0, error: 0, warning: 0, info: 0, verbose: 0 };
    const sources = new Map<string, number>();
    for (const e of base) {
      if (!isCountable(e)) continue;
      counts.all++;
      if (e.type === 'console.message') counts.user++;
      counts[severityOf(e)]++;
      const src = sourceOf(e);
      if (src) sources.set(src, (sources.get(src) ?? 0) + 1);
    }
    return { counts, sources: Array.from(sources.entries()).sort((a, b) => b[1] - a[1]) };
  }, [base]);
  const shown = useMemo(() => {
    switch (sidebarSel.kind) {
      case 'all':
        return base;
      case 'user':
        return base.filter((e) => e.type === 'console.message' || !isCountable(e));
      case 'level':
        return base.filter((e) => !isCountable(e) || severityOf(e) === sidebarSel.level);
      case 'source':
        return base.filter((e) => !isCountable(e) || sourceOf(e) === sidebarSel.source);
    }
  }, [base, sidebarSel]);
  const effectiveLevels = sidebarSel.kind === 'level' ? ALL_LEVELS : levels;
  const rows = useMemo(
    () => filterTree(buildTree(shown, settings.groupSimilar), effectiveLevels, filter),
    [shown, settings.groupSimilar, effectiveLevels, filter],
  );
  const rowByKey = useMemo(() => {
    const map = new Map<string, Row>();
    const walk = (list: Row[]) => {
      for (const r of list) {
        map.set(r.key, r);
        if (r.children) walk(r.children);
      }
    };
    walk(rows);
    return map;
  }, [rows]);

  const onRowContextMenu = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.console-row[data-key]');
    if (!el) return;
    const row = rowByKey.get(el.dataset.key ?? '');
    if (!row) return;
    e.preventDefault();
    const text = rowText(row);
    const firstObject = row.entry.type === 'console.message' ? row.entry.args.find((a) => a.t === 'object' || a.t === 'array') : undefined;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copy message', onClick: () => void copyText(text) },
        { label: 'Copy object', disabled: !firstObject, onClick: () => void copyText(firstObject ? formatValueJson(firstObject) : '') },
        { separator: true },
        { label: 'Hide messages like this', onClick: () => setFilter((f) => `${f} -${quoteTerm(text.slice(0, 40))}`.trim()) },
        { label: 'Show only messages like this', onClick: () => setFilter(quoteTerm(text.slice(0, 40))) },
        { separator: true },
        { label: 'Clear console', onClick: () => store.getState().clearConsole() },
      ],
    });
  };

  // Stick to the bottom unless the user scrolled up.
  const listRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  // "Reveal in Console" (from History): scroll the matching row into view and flash it.
  const reveal = useConsoleSelection();
  /** the reveal we already relaxed the filters for, so it happens at most once */
  const relaxed = useRef<number | null>(null);
  useEffect(() => {
    if (reveal.sessionId !== sessionId || reveal.seq == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`.console-row[data-key="${reveal.seq}"]`);
    if (!el) {
      // The row exists but nothing is drawn for it: a filter, a level, the
      // sidebar or "group similar" folding it into an earlier duplicate. Drop
      // what can hide it and let the next render try again, once.
      if (relaxed.current !== reveal.nonce) {
        relaxed.current = reveal.nonce;
        setFilter('');
        setLevels(DEFAULT_LEVELS);
        setSidebarSel({ kind: 'all' });
        setSettings({ ...settings, groupSimilar: false });
        return;
      }
      useConsoleSelection.getState().clear();
      return;
    }
    // Done: without clearing, every later message would re-run this and yank
    // the list back to the revealed row forever.
    useConsoleSelection.getState().clear();
    atBottom.current = false;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('console-row-flash');
    const t = setTimeout(() => el.classList.remove('console-row-flash'), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.nonce, reveal.sessionId, reveal.seq, sessionId, rows]);

  const submit = async (expression: string) => {
    // Stamp the window the prompt ran in, so the entry stays under that tab.
    const target = activeTab ?? undefined;
    store.getState().pushLocal({ type: 'eval.command', ts: Date.now(), expression }, target);
    const reply = await evaluate(sessionId, expression);
    store.getState().pushLocal({ type: 'eval.result', ts: Date.now(), result: reply.result, exception: reply.exception }, target);
  };

  // Memoised: this rebuilds the group tree, which compares every adjacent pair
  // of messages, and it used to run on every render of the panel.
  const hidden = useMemo(() => countLeaves(buildTree(shown, settings.groupSimilar)) - countLeaves(rows), [shown, settings.groupSimilar, rows]);

  return (
    <>
      <Toolbar>
        <ToolbarButton title="Show console sidebar" onClick={() => setSidebarOpen((o) => !o)}>
          <SidebarIcon active={sidebarOpen} />
        </ToolbarButton>
        <ToolbarButton title="Clear console (Ctrl+L)" onClick={() => store.getState().clearConsole()}>
          <ClearIcon />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarInput placeholder="Filter" value={filter} onChange={setFilter} find />
        <LevelMenu value={levels} onChange={setLevels} />
        {hidden > 0 && <span className="console-hidden-count">{hidden} hidden</span>}
        <ToolbarDivider />
        <ToolbarButton title="Create live expression" onClick={() => setLiveOpen((o) => !o)}>
          <EyeIcon active={liveOpen} />
        </ToolbarButton>
        <div style={{ flex: 1 }} />
        <div className="console-settings">
          <ToolbarButton title="Console settings" onClick={() => setSettingsOpen((o) => !o)}>
            <GearIcon active={settingsOpen} />
          </ToolbarButton>
          {settingsOpen && (
            <div className="console-settings-popup" onMouseLeave={() => setSettingsOpen(false)}>
              <label>
                <input type="checkbox" checked={settings.hideNetwork} onChange={(e) => setSettings({ ...settings, hideNetwork: e.target.checked })} />
                Hide network
              </label>
              <label>
                <input type="checkbox" checked={preserveLog} onChange={(e) => store.getState().setPreserveLog(e.target.checked)} />
                Preserve log
              </label>
              <label>
                <input type="checkbox" checked={settings.timestamps} onChange={(e) => setSettings({ ...settings, timestamps: e.target.checked })} />
                Show timestamps
              </label>
              <label>
                <input type="checkbox" checked={settings.groupSimilar} onChange={(e) => setSettings({ ...settings, groupSimilar: e.target.checked })} />
                Group similar messages in console
              </label>
              <label>
                <input type="checkbox" checked={settings.eagerEval} onChange={(e) => setSettings({ ...settings, eagerEval: e.target.checked })} />
                Eager evaluation
              </label>
            </div>
          )}
        </div>
      </Toolbar>

      {liveOpen && (
        <div className="console-live mono">
          {live.map((expr) => (
            <div key={expr} className="console-live-row">
              <span className="console-live-expr" title={expr}>
                {expr}
              </span>
              <span className="console-live-value">
                {liveValues[expr] ? <ObjectTree value={liveValues[expr]!} sessionId={sessionId} /> : <span className="tok-meta">not available</span>}
              </span>
              <button className="console-live-remove" title="Remove expression" onClick={() => setLive(live.filter((x) => x !== expr))}>
                ✕
              </button>
            </div>
          ))}
          <div className="console-live-row add">
            <span className="console-live-eye">👁</span>
            <input
              className="console-live-input"
              placeholder="Expression"
              value={liveDraft}
              spellCheck={false}
              onChange={(e) => setLiveDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && liveDraft.trim()) {
                  setLive([...live.filter((x) => x !== liveDraft.trim()), liveDraft.trim()]);
                  setLiveDraft('');
                }
              }}
            />
          </div>
        </div>
      )}

      <div className="console-main">
        {sidebarOpen && (
          <div className="console-sidebar">
            {(
              [
                ['all', `${sidebar.counts.all} messages`, { kind: 'all' } as SidebarSel],
                ['user', `${sidebar.counts.user} user messages`, { kind: 'user' } as SidebarSel],
                ['error', `${sidebar.counts.error} errors`, { kind: 'level', level: 'error' } as SidebarSel],
                ['warning', `${sidebar.counts.warning} warnings`, { kind: 'level', level: 'warning' } as SidebarSel],
                ['info', `${sidebar.counts.info} info`, { kind: 'level', level: 'info' } as SidebarSel],
                ['verbose', `${sidebar.counts.verbose} verbose`, { kind: 'level', level: 'verbose' } as SidebarSel],
              ] as const
            ).map(([key, label, sel]) => (
              <div
                key={key}
                className={`console-sidebar-item level-${key}${sameSel(sidebarSel, sel) ? ' selected' : ''}`}
                onClick={() => setSidebarSel(sel)}
              >
                <span className="console-sidebar-arrow" />
                {label}
              </div>
            ))}
            {sidebar.sources.length > 0 && <div className="console-sidebar-head">Sources</div>}
            {sidebar.sources.map(([src, n]) => (
              <div
                key={src}
                className={`console-sidebar-item source${sidebarSel.kind === 'source' && sidebarSel.source === src ? ' selected' : ''}`}
                title={src}
                onClick={() => setSidebarSel({ kind: 'source', source: src })}
              >
                <span className="console-sidebar-count">{n}</span> {src}
              </div>
            ))}
          </div>
        )}

        {/* The prompt scrolls with the messages, right after the last one, like DevTools. */}
        <div
          className="console-messages mono"
          ref={listRef}
          onScroll={onScroll}
          onClick={(e) => {
            if (e.target === e.currentTarget) promptRef.current?.focus();
          }}
          onContextMenu={onRowContextMenu}
        >
          {rows.length === 0 && entries.length === 0 && (
            <div className="console-empty">No messages yet. Interact with the page, or evaluate something below.</div>
          )}
          {rows.map((row) => (
            <ConsoleRow key={row.key} row={row} sessionId={sessionId} settings={settings} />
          ))}
          <ConsolePrompt sessionId={sessionId} onSubmit={(e) => void submit(e)} disabled={!connected} inputRef={promptRef} eager={settings.eagerEval} />
        </div>
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </>
  );
}

// ------------------------------------------------------------------- rows

function ConsoleRow({ row, sessionId, settings }: { row: Row; sessionId: string; settings: Settings }) {
  const { entry } = row;

  if (row.children) return <GroupRow row={row} sessionId={sessionId} settings={settings} />;

  switch (entry.type) {
    case 'console.clear':
      return (
        <Line severity="info" entry={entry} settings={settings} className="console-cleared">
          Console was cleared
        </Line>
      );

    case 'page.navigated':
      return (
        <Line severity="info" entry={entry} settings={settings} className="console-navigated">
          Navigated to <a href={entry.url} target="_blank" rel="noreferrer">{entry.url}</a>
        </Line>
      );

    case 'network.error': {
      const sid = sessionId;
      return (
        <Line severity="error" entry={entry} settings={settings} repeat={row.repeat}>
          <span className="console-network-error">
            {entry.method}{' '}
            <a
              href={entry.url}
              onClick={(e) => {
                e.preventDefault();
                revealRequest(sid, entry.requestId);
              }}
              title="Reveal in Network"
            >
              {entry.url}
            </a>{' '}
            {entry.status !== undefined ? `${entry.status} (${entry.statusText || 'error'})` : entry.error}
          </span>
        </Line>
      );
    }

    case 'eval.command':
      return (
        <Line severity="info" entry={entry} settings={settings} className="console-command" icon={<span className="console-chevron">›</span>}>
          <span className="console-command-text">{entry.expression}</span>
        </Line>
      );

    case 'eval.result': {
      const value = entry.exception ?? entry.result ?? { t: 'undefined' as const };
      return (
        <Line severity={severityOf(entry)} entry={entry} settings={settings} className="console-result" icon={<span className="console-chevron">‹</span>}>
          {entry.exception && <span className="console-uncaught">Uncaught </span>}
          <ObjectTree value={value} sessionId={sessionId} />
        </Line>
      );
    }

    case 'error.uncaught':
      return (
        <Line
          severity="error"
          entry={entry}
          settings={settings}
          repeat={row.repeat}
          location={shortLocation(entry.source ? { fn: '', url: entry.source, line: entry.line ?? 0, col: entry.col ?? 0, raw: '' } : undefined)}
          locationHref={entry.source}
          locationLine={entry.line}
        >
          <span className="console-uncaught">Uncaught </span>
          <span>{entry.message.replace(/^Uncaught\s+/, '')}</span>
          {entry.stack && <StackTrace stack={stripFirstLine(entry.stack)} />}
          {entry.cause && (
            <div className="console-cause">
              <span className="tok-meta">Caused by: </span>
              <ObjectTree value={entry.cause} sessionId={sessionId} />
            </div>
          )}
        </Line>
      );

    case 'error.unhandledrejection': {
      const top = entry.reason.t === 'error' ? parseStack(entry.reason.stack)[0] : undefined;
      return (
        <Line severity="error" entry={entry} settings={settings} repeat={row.repeat} location={shortLocation(top)} locationHref={top?.url} locationLine={top?.line}>
          <span className="console-uncaught">Uncaught (in promise) </span>
          <ObjectTree value={entry.reason} sessionId={sessionId} />
        </Line>
      );
    }

    case 'console.message':
      return <MessageRow row={row} sessionId={sessionId} settings={settings} />;
  }
}

function MessageRow({ row, sessionId, settings }: { row: Row; sessionId: string; settings: Settings }) {
  const entry = row.entry as Extract<ConsoleEntry, { type: 'console.message' }>;
  const frames = parseStack(entry.stack);
  const top = frames[0];
  const severity = severityOf(entry);

  const showStack = entry.level === 'trace' || entry.level === 'error' || entry.level === 'assert' || entry.level === 'warn';
  const [stackOpen, setStackOpen] = useState(entry.level === 'trace');

  let body: ReactNode;
  if (entry.level === 'table' && entry.args[0]) {
    body = (
      <>
        <TableView value={entry.args[0]} />
        <ObjectTree value={entry.args[0]} sessionId={sessionId} />
      </>
    );
  } else if (entry.level === 'dir' && entry.args[0]) {
    body = <ObjectTree value={entry.args[0]} sessionId={sessionId} expanded={false} />;
  } else {
    body = <Segments entry={entry} sessionId={sessionId} />;
  }

  return (
    <Line
      severity={severity}
      entry={entry}
      settings={settings}
      repeat={row.repeat}
      location={shortLocation(top)}
      locationHref={top?.url}
      locationLine={top?.line}
      className={`level-${entry.level}`}
    >
      {showStack && frames.length > 0 && (
        <span className={`otree-arrow${stackOpen ? ' open' : ''} console-stack-toggle`} onClick={() => setStackOpen((o) => !o)} />
      )}
      {body}
      {showStack && stackOpen && <StackTrace stack={entry.stack} />}
    </Line>
  );
}

/** The arguments of one console call, with %-format applied to the first. */
function Segments({ entry, sessionId }: { entry: Extract<ConsoleEntry, { type: 'console.message' }>; sessionId: string }) {
  const segments = applyFormat(entry.args);
  return (
    <>
      {segments.map((seg, i) => {
        const space = i > 0 && !(segments[i - 1]?.kind === 'text' && seg.kind === 'text') ? ' ' : '';
        if (seg.kind === 'text') {
          return (
            <span key={i} style={seg.style}>
              {space}
              {seg.text}
            </span>
          );
        }
        return (
          <span key={i} style={seg.style}>
            {space}
            <ObjectTree value={seg.value} sessionId={sessionId} topLevel />
          </span>
        );
      })}
    </>
  );
}

function GroupRow({ row, sessionId, settings }: { row: Row; sessionId: string; settings: Settings }) {
  const entry = row.entry as Extract<ConsoleEntry, { type: 'console.message' }>;
  const [open, setOpen] = useState(entry.level !== 'groupCollapsed');
  return (
    <div className="console-group">
      <Line severity="info" entry={entry} settings={settings} className="console-group-header" onClick={() => setOpen((o) => !o)}>
        <span className={`otree-arrow${open ? ' open' : ''}`} />
        <span className="console-group-title">
          {entry.args.map((a, i) => (
            <span key={i}>
              {i > 0 && ' '}
              <Inline value={a} mode="top" />
            </span>
          ))}
        </span>
      </Line>
      {open && (
        <div className="console-group-children">
          {row.children!.map((child) => (
            <ConsoleRow key={child.key} row={child} sessionId={sessionId} settings={settings} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One console row: gutter icon · body · source link. */
function Line({
  severity,
  entry,
  settings,
  repeat = 1,
  location,
  locationHref,
  locationLine,
  className = '',
  icon,
  onClick,
  children,
}: {
  severity: 'verbose' | 'info' | 'warning' | 'error';
  entry: ConsoleEntry;
  settings: Settings;
  repeat?: number;
  location?: string;
  locationHref?: string | undefined;
  locationLine?: number | undefined;
  className?: string;
  icon?: ReactNode;
  onClick?: () => void;
  children: ReactNode;
}) {
  const isInfoLevel = entry.type === 'console.message' && entry.level === 'info';
  return (
    <div className={`console-row severity-${severity} ${className}`} onClick={onClick} data-key={String(entry.seq)}>
      {settings.timestamps && <span className="console-timestamp" title={fullTimestamp(entry.ts)}>{formatTime(entry.ts)}</span>}
      <span className="console-gutter">
        {repeat > 1 ? (
          <span className={`console-repeat severity-${severity}`}>{repeat}</span>
        ) : (
          icon ?? (severity === 'error' ? <ErrorIcon /> : severity === 'warning' ? <WarnIcon /> : isInfoLevel ? <InfoIcon /> : null)
        )}
      </span>
      <span className="console-body">{children}</span>
      {location && locationHref && (
        <SourceLink className="console-location" url={locationHref} line={locationLine} title={locationHref}>
          {location}
        </SourceLink>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function formatValueJson(v: SerializedValueLike): string {
  return JSON.stringify(toPlain(v), null, 2);
}
type SerializedValueLike = Parameters<typeof toPlain>[0];
function toPlain(v: import('@bxconsole/protocol').SerializedValue): unknown {
  switch (v.t) {
    case 'object':
      return Object.fromEntries(v.preview.map((p) => [p.name, toPlain(p.value)]));
    case 'array':
      return v.preview.map(toPlain);
    case 'string':
    case 'boolean':
      return v.v;
    case 'number':
      return typeof v.v === 'number' ? v.v : v.v;
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    default:
      return formatValue(v, 'nested');
  }
}

function quoteTerm(text: string): string {
  const word = text.trim().split(/\s+/)[0] ?? '';
  return word.replace(/[^\w$./:-]/g, '');
}

function isCountable(e: ConsoleEntry): boolean {
  if (e.type === 'console.message') return e.level !== 'groupEnd';
  return e.type === 'error.uncaught' || e.type === 'error.unhandledrejection' || e.type === 'network.error';
}

/** Source file of a message, for the sidebar's per-source counts. */
function sourceOf(e: ConsoleEntry): string | null {
  if (e.type === 'console.message') {
    const top = parseStack(e.stack)[0];
    return top ? fileOf(top.url) : null;
  }
  if (e.type === 'error.uncaught') return e.source ? fileOf(e.source) : null;
  if (e.type === 'network.error') return fileOf(e.url);
  return null;
}
function fileOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}
function sameSel(a: { kind: string; level?: string; source?: string }, b: { kind: string; level?: string; source?: string }): boolean {
  return a.kind === b.kind && a.level === b.level && a.source === b.source;
}

function SidebarIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${active ? ' active' : ''}`}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
function EyeIcon({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${active ? ' active' : ''}`}>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" />
    </svg>
  );
}

function countLeaves(rows: Row[]): number {
  let n = 0;
  for (const r of rows) n += r.children ? countLeaves(r.children) : 1;
  return n;
}

function stripFirstLine(stack: string): string {
  const lines = stack.split('\n');
  return /^\s*at\s|@/.test(lines[0] ?? '') ? stack : lines.slice(1).join('\n');
}

// ------------------------------------------------------------------- icons

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="console-icon error">
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="console-icon warning">
      <path d="M7 1.5L13 12.5H1z" fill="currentColor" />
      <path d="M7 5.5v3.5" stroke="#000" strokeWidth="1.4" />
      <circle cx="7" cy="10.8" r="0.8" fill="#000" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="console-icon info">
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M7 6v4" stroke="#fff" strokeWidth="1.4" />
      <circle cx="7" cy="4" r="0.8" fill="#fff" />
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
