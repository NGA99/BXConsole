/**
 * The DevTools frame.
 *
 *   no session   top bar · Sessions list (full width)
 *   session      top bar (back to list · session picker)
 *                ┌──────────────┬──────────────────────┐
 *                │ Screen       │ Console | Network    │
 *                │ (collapsible)│ (tab strip + panel)  │
 *                └──────────────┴──────────────────────┘
 *
 * Like Chrome, panels stay mounted when you switch tabs; they are toggled
 * with `hidden`. The Screen pane is the exception: collapsing it unmounts
 * the mirror, which stops the agent from streaming.
 */
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { sessionData } from '../state/session-data';
import { TabBar, type Tab } from '../devtools-ui/TabBar';
import { SplitView } from '../devtools-ui/SplitView';
import { CollapseRightPaneIcon } from '../devtools-ui/icons';
import { SessionsPanel } from '../panels/sessions/SessionsPanel';
import { ConsolePanel } from '../panels/console/ConsolePanel';
import { NetworkPanel } from '../panels/network/NetworkPanel';
import { ElementsPanel } from '../panels/elements/ElementsPanel';
import { SourcesPanel } from '../panels/sources/SourcesPanel';
import { HistoryPanel } from '../panels/history/HistoryPanel';
import { SessionLabel } from './SessionLabel';
import { BrowserChrome } from './BrowserChrome';
import { useActiveTab } from '../state/active-tab';
import { SessionContext } from './session-context';
import { ScreenPanel } from '../panels/screen/ScreenPanel';
import { ProjectBar, TopBarProject, TopBarAccount } from '../panels/sessions/ProjectBar';
import { useSessionsStore } from '../state/sessions';
import { subscribeSession } from '../transport/client';
import { ContextMenu } from '../devtools-ui/ContextMenu';
import { ErrorBoundary } from '../devtools-ui/ErrorBoundary';
import { useInspectMode } from '../state/inspect-mode';
import { useScreenReplay } from '../state/screen-replay';
import { useMenuStore } from '../devtools-ui/menu-store';
import { navigate, type PanelId, type Route } from './router';
import './Shell.css';

const RIGHT_TABS: Tab<PanelId>[] = [
  { id: 'elements', label: 'Elements' },
  { id: 'console', label: 'Console' },
  { id: 'sources', label: 'Sources' },
  { id: 'network', label: 'Network' },
  { id: 'history', label: 'History' },
];

const SCREEN_KEY = 'bxconsole.screen.collapsed';
const DEVTOOLS_KEY = 'bxconsole.devtools.collapsed';
const THEME_KEY = 'bxconsole.theme';
type Theme = 'system' | 'light' | 'dark';

function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/** Chrome's top-right error / warning counters for the current session. */
function useIssueCounts(sessionId: string | null): { errors: number; warnings: number } {
  const store = sessionData(sessionId ?? '__none__');
  // Read the running totals: scanning the buffer here re-ran on every event,
  // including network ones, for up to five thousand entries.
  return store(useShallow((s) => s.issues));
}

/**
 * The window's title bar: the one row that should look the same wherever you
 * are.
 *
 * It used to be written out twice, once for the session list and once for an
 * open session, and the two drifted apart. The list kept the relay status
 * tucked beside the wordmark while the session pushed it to the far right,
 * and the session dropped the wordmark altogether — so moving between the two
 * views rearranged the bar under you. One component holds the shape now, and
 * a view supplies only the navigation that is its own.
 */
function TopBar({
  relayUp,
  theme,
  onCycleTheme,
  children,
  trailing,
}: {
  relayUp: boolean;
  theme: Theme;
  onCycleTheme: () => void;
  children?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="topbar">
      <span className="topbar-title">BXConsole</span>
      {children}
      <div className="topbar-spacer" />
      {trailing}
      <span className={`relay-status ${relayUp ? 'on' : 'off'}`}>{relayUp ? 'relay connected' : 'relay disconnected'}</span>
      <button className="topbar-theme" title={`Theme: ${theme} (click to change)`} onClick={onCycleTheme}>
        {theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}
      </button>
    </div>
  );
}

export function Shell({ route }: { route: Route }) {
  const relayUp = useSessionsStore((s) => s.relayConnected);
  const globalMenu = useMenuStore((s) => s.menu);
  const closeGlobalMenu = useMenuStore((s) => s.close);
  const inspectOn = useInspectMode((s) => s.on);
  const counts = useIssueCounts(route.sessionId);
  // Elements and Sources read one window's DOM and files, so they start over when it changes.
  const activeTab = useActiveTab(route.sessionId ?? '');
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => applyTheme(theme), [theme]);
  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  };

  // DevTools shortcuts: ⌘K / Ctrl+L clear the console, ⌘F / Ctrl+F focus the visible
  // panel's filter — except on Network, which has a search of its own to open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !route.sessionId) return;
      if ((e.key === 'k' && e.metaKey) || (e.key === 'l' && e.ctrlKey)) {
        if (route.panel === 'console') {
          e.preventDefault();
          sessionData(route.sessionId).getState().clearConsole();
        }
      } else if (e.key === 'f') {
        // Network answers Find for itself: it has a search that looks inside
        // the rows, which is a different question from the filter that
        // decides which rows are listed. See NetworkPanel.
        if (route.panel === 'network') return;
        const input =
          document.querySelector<HTMLInputElement>('.shell-panel:not([hidden]) [data-find]') ??
          document.querySelector<HTMLInputElement>('.shell-panel:not([hidden]) .toolbar-input, .shell-panel:not([hidden]) .network-filter-input');
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route.panel, route.sessionId]);
  const [screenCollapsed, setScreenCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SCREEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setCollapsed = (v: boolean) => {
    setScreenCollapsed(v);
    try {
      localStorage.setItem(SCREEN_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  // Folding the panels away to see the page full width. Only one side folds
  // at a time: both at once would leave an empty window with two strips and
  // nothing to read.
  const [devtoolsCollapsed, setDevtoolsCollapsed] = useState(() => {
    try {
      return localStorage.getItem(DEVTOOLS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setDevtools = (v: boolean) => {
    setDevtoolsCollapsed(v);
    try {
      localStorage.setItem(DEVTOOLS_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (route.sessionId) subscribeSession(route.sessionId);
  }, [route.sessionId]);
  // "Show the screen at this moment" (History) needs the mirror on screen.
  const replayNonce = useScreenReplay((s) => s.nonce);
  useEffect(() => {
    if (replayNonce > 0) setCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayNonce]);
  // Sources is mounted on first visit and then kept (hidden) so the open file survives tab switches.
  const [sourcesVisited, setSourcesVisited] = useState(false);
  useEffect(() => {
    if (route.panel === 'sources') setSourcesVisited(true);
  }, [route.panel]);

  if (!route.sessionId) {
    return (
      <div className="shell">
        <TopBar relayUp={relayUp} theme={theme} onCycleTheme={cycleTheme} trailing={<TopBarAccount />}>
          <TopBarProject view={route.view} />
        </TopBar>
        <div className="shell-body">
          <div className="shell-panel">
            {/* Its own boundary, outside the top bar: this list is the way in
                to everything, so when a recording it cannot render takes it
                down the operator must still have a frame to act in. */}
            <ErrorBoundary label="The session list">
              <SessionsPanel view={route.view} />
            </ErrorBoundary>
          </div>
        </div>
        <ContextMenu menu={globalMenu} onClose={closeGlobalMenu} />
      </div>
    );
  }

  const sessionId = route.sessionId;
  const toSessions = { label: 'All sessions', go: () => navigate({ panel: 'sessions', sessionId: null }) };
  const badges = (counts.errors > 0 || counts.warnings > 0) && (
    <span className="issue-badges" title="Errors and warnings in this session's console" onClick={() => navigate({ panel: 'console', sessionId })}>
      {counts.errors > 0 && (
        <span className="issue-badge error">
          <svg width="12" height="12" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="6" fill="currentColor" />
            <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#fff" strokeWidth="1.4" />
          </svg>
          {counts.errors}
        </span>
      )}
      {counts.warnings > 0 && (
        <span className="issue-badge warning">
          <svg width="12" height="12" viewBox="0 0 14 14">
            <path d="M7 1.5L13 12.5H1z" fill="currentColor" />
            <path d="M7 5.5v3.5" stroke="#000" strokeWidth="1.4" />
            <circle cx="7" cy="10.8" r="0.8" fill="#000" />
          </svg>
          {counts.warnings}
        </span>
      )}
    </span>
  );
  const inspectButton = (
    <span className="strip-leading">
      <button
        className={`toolbar-button${inspectOn ? ' active' : ''}`}
        title="Select an element in the page to inspect it (picks one element, then turns off)"
        onClick={() => {
          const next = !inspectOn;
          useInspectMode.getState().set(next);
          if (next && screenCollapsed) setCollapsed(false);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${inspectOn ? ' active' : ''}`}>
          <path d="M2 2h7v1.5H3.5V9H2z M7 7l7 2.6-2.9 1.1L13 13.6 11.6 15l-2.9-2.9L7.6 15z" fill="currentColor" />
        </svg>
      </button>
    </span>
  );
  const rightPane = (onCollapse?: () => void) => (
    <div className="dock-right">
      <TabBar
        tabs={RIGHT_TABS}
        active={route.panel}
        onSelect={(panel) => navigate({ panel, sessionId })}
        trailing={
          <>
            {badges}
            {onCollapse && (
              <button className="tabbar-action" title="Hide the panels" onClick={onCollapse}>
                <CollapseRightPaneIcon />
              </button>
            )}
          </>
        }
        leading={inspectButton}
      />
      <div className="shell-body">
        {/* Elements streams the DOM while open, so it is mounted only when shown. */}
        {route.panel === 'elements' && (
          <div className="shell-panel">
            <ErrorBoundary label="Elements" onLeave={toSessions}>
              <ElementsPanel key={`${sessionId}:${activeTab ?? ''}`} sessionId={sessionId} />
            </ErrorBoundary>
          </div>
        )}
        {/* Keyed by session: filters, level, live expressions and the sidebar
            selection are per session, and without this they follow you into
            the next one and live expressions run against the wrong page. */}
        <div hidden={route.panel !== 'console'} className="shell-panel">
          <ErrorBoundary label="Console" onLeave={toSessions}>
            <ConsolePanel key={sessionId} sessionId={sessionId} />
          </ErrorBoundary>
        </div>
        {sourcesVisited && (
          <div hidden={route.panel !== 'sources'} className="shell-panel">
            <ErrorBoundary label="Sources" onLeave={toSessions}>
              <SourcesPanel key={`${sessionId}:${activeTab ?? ''}`} sessionId={sessionId} />
            </ErrorBoundary>
          </div>
        )}
        <div hidden={route.panel !== 'network'} className="shell-panel">
          <ErrorBoundary label="Network" onLeave={toSessions}>
            <NetworkPanel key={sessionId} sessionId={sessionId} />
          </ErrorBoundary>
        </div>
        <div hidden={route.panel !== 'history'} className="shell-panel">
          <ErrorBoundary label="History" onLeave={toSessions}>
            <HistoryPanel key={sessionId} sessionId={sessionId} active={route.panel === 'history'} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );

  return (
    <SessionContext.Provider value={sessionId}>
    <div className="shell">
      <TopBar relayUp={relayUp} theme={theme} onCycleTheme={cycleTheme} trailing={<TopBarAccount />}>
        <TopBarProject sessionId={sessionId} />
        <SessionLabel sessionId={sessionId} />
      </TopBar>
      <ProjectBar showing="inside" session={{ id: sessionId, panel: route.panel }} />
      {/* Below the strip, so opening a window never moves the rows above it. */}
      <BrowserChrome sessionId={sessionId} />
      {screenCollapsed ? (
        <div className="dock">
          <div className="dock-strip">
            <button className="dock-strip-button" title="Show screen" onClick={() => setCollapsed(false)}>
              ◨ Screen
            </button>
          </div>
          {rightPane()}
        </div>
      ) : devtoolsCollapsed ? (
        <div className="dock">
          <div className="dock-left">
            <ErrorBoundary label="Screen" onLeave={toSessions}>
              <ScreenPanel key={sessionId} sessionId={sessionId} />
            </ErrorBoundary>
          </div>
          <div className="dock-strip right">
            <button className="dock-strip-button" title="Show the panels" onClick={() => setDevtools(false)}>
              ◧ Panels
            </button>
          </div>
        </div>
      ) : (
        <div className="dock">
          <SplitView
            main={
              <div className="dock-left">
                <ErrorBoundary label="Screen" onLeave={toSessions}>
                  <ScreenPanel key={sessionId} sessionId={sessionId} onCollapse={() => setCollapsed(true)} />
                </ErrorBoundary>
              </div>
            }
            side={rightPane(() => setDevtools(true))}
            initialSide={Math.max(320, Math.round(window.innerWidth * 0.45))}
            minMain={240}
            minSide={320}
            storageKey="bxconsole.dock.right"
          />
        </div>
      )}
      <ContextMenu menu={globalMenu} onClose={closeGlobalMenu} />
    </div>
    </SessionContext.Provider>
  );
}
