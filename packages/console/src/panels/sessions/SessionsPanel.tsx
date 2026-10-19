/**
 * Sessions tab: every debugging run the relay knows about, live or recorded.
 *
 * Two views, because they answer different questions: the list is "what can I
 * open", and Install is "how do I start one". The install snippets used to sit
 * under the list, where a long list buried them.
 *
 * A row is a run, not a window: a run that opened other windows shows how many
 * it holds, and clicking it opens the run with those windows as tabs.
 */
import { useState } from 'react';
import { assetPath, type SessionMeta } from '@bxconsole/protocol';
import { browserInfo, browserLabel, platformLabel } from './browser-info';
import { useSessionList } from '../../state/sessions';
import { forgetSession, trashSession, restoreSession } from '../../transport/client';
import { navigate, navigateToView, type SessionView } from '../../app/router';
import { fullTimestamp, friendlyTimestamp } from '../../devtools-ui/time';
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarInput } from '../../devtools-ui/Toolbar';
import { TabBar } from '../../devtools-ui/TabBar';
import { AgentPanel } from './AgentPanel';
import { WebhookPanel } from './WebhookPanel';
import './SessionsPanel.css';

export function SessionsPanel({ view }: { view: SessionView }) {
  const all = useSessionList();
  const setView = navigateToView;
  const [query, setQuery] = useState('');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const q = query.trim().toLowerCase();
  const trashed = all.filter((s) => s.trashedAt !== undefined);
  const kept = all.filter((s) => s.trashedAt === undefined);
  const offline = kept.filter((s) => !s.connected);
  const live = kept.length - offline.length;
  const sessions = (view === 'trash' ? trashed : kept).filter((s) => {
    if (view !== 'trash' && connectedOnly && !s.connected) return false;
    if (!q) return true;
    return [s.name, s.title, s.url, s.sessionId, s.userAgent].some((v) => v?.toLowerCase().includes(q));
  });
  // Live runs first: those are the ones you can still act on.
  const ordered = [...sessions].sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastSeenAt - a.lastSeenAt);

  return (
    <>
      <TabBar
        tabs={[
          { id: 'sessions', label: live > 0 ? `Sessions (${live} live)` : 'Sessions' },
          { id: 'webhook', label: 'Webhook' },
          { id: 'trash', label: trashed.length > 0 ? `Trash (${trashed.length})` : 'Trash' },
          { id: 'agent', label: 'Agent' },
        ]}
        active={view}
        onSelect={setView}
      />
      {view === 'webhook' ? (
        <WebhookPanel />
      ) : view === 'agent' ? (
        <div className="sessions-list">
          <AgentPanel onDiagnose={() => setView('webhook')} />
        </div>
      ) : (
        <SessionList
          trash={view === 'trash'}
          ordered={ordered}
          all={all}
          offline={offline}
          live={live}
          query={query}
          setQuery={setQuery}
          connectedOnly={connectedOnly}
          setConnectedOnly={setConnectedOnly}
          onInstall={() => setView('agent')}
        />
      )}
    </>
  );
}

function SessionList({
  trash,
  ordered,
  all,
  offline,
  live,
  query,
  setQuery,
  connectedOnly,
  setConnectedOnly,
  onInstall,
}: {
  trash: boolean;
  ordered: SessionMeta[];
  all: SessionMeta[];
  offline: SessionMeta[];
  live: number;
  query: string;
  setQuery: (v: string) => void;
  connectedOnly: boolean;
  setConnectedOnly: (v: boolean) => void;
  onInstall: () => void;
}) {
  const sessions = ordered;
  return (
    <>
      <Toolbar>
        <ToolbarInput placeholder="Filter sessions" value={query} onChange={setQuery} />
        {!trash && (
          <label className="toolbar-check">
            <input type="checkbox" checked={connectedOnly} onChange={(e) => setConnectedOnly(e.target.checked)} /> Connected only
          </label>
        )}
        <ToolbarDivider />
        <span className="sessions-count">{trash ? `${sessions.length} in the trash` : `${live} live · ${offline.length} recorded`}</span>
        <div style={{ flex: 1 }} />
        {trash ? (
          <ToolbarButton
            title={`Delete every recording in the trash for good (${sessions.length})`}
            disabled={sessions.length === 0}
            onClick={() => sessions.forEach((s) => forgetSession(s.sessionId))}
          >
            Empty trash
          </ToolbarButton>
        ) : (
          <ToolbarButton
            title={`Move the recording of every session whose page is gone to the trash (${offline.length})`}
            disabled={offline.length === 0}
            onClick={() => offline.forEach((s) => trashSession(s.sessionId))}
          >
            Trash {offline.length} recorded
          </ToolbarButton>
        )}
      </Toolbar>
      <div className="sessions-list">
        {sessions.length === 0 && (
          <div className="sessions-empty">
            {trash ? (
              'The trash is empty.'
            ) : all.length === 0 ? (
              <>
                No sessions yet. <button className="sessions-link" onClick={onInstall}>Install the agent</button> in a page to start one.
              </>
            ) : (
              'No session matches the filter.'
            )}
          </div>
        )}
        {sessions.map((s) => (
          <div
            key={s.sessionId}
            className={`session-row${s.connected ? '' : ' offline'}`}
            onClick={() => navigate({ panel: 'console', sessionId: s.sessionId })}
          >
            <span className={`dot ${s.connected ? 'on' : 'off'}`} />
            <Favicon url={s.url} sessionId={s.sessionId} />
            <div className="session-main">
              {/* Always three cells, even when there is no page title: with two
                  the id slides into the middle column and stops lining up. */}
              <div className="session-title">
                <span className="session-name">{s.name ?? s.title ?? '(untitled)'}</span>
                <span className="session-page-title">{s.name && s.title ? s.title : ''}</span>
                <span className="session-id mono">session-{s.sessionId}</span>
              </div>
              <div className="session-url mono" title={s.url}>
                {shortenUrl(s.url)}
              </div>
            </div>
            {/* Each of these is its own grid cell, so the columns line up down
                the list instead of landing wherever the text happens to end. */}
            <div className="session-windows-cell">
              {windowCount(s) > 1 && (
                <span className="session-windows" title={`${windowCount(s)} windows in this run, ${liveWindows(s)} still open`}>
                  {liveWindows(s)}/{windowCount(s)}
                </span>
              )}
            </div>
            {/* Two lines, like the timestamp opposite it: which browser ran
                the payload, and where. On a blind XSS run that is most of
                what is known about whose browser this was. */}
            <div className="session-env" title={s.userAgent}>
              <span>{browserLabel(browserInfo(s.userAgent))}</span>
              <span className="session-env-platform">{platformLabel(browserInfo(s.userAgent), s.viewport)}</span>
            </div>
            <div
              className="session-time"
              title={s.connected ? `Agent installed at ${fullTimestamp(s.startedAt)}` : `Last event at ${fullTimestamp(s.lastSeenAt)}`}
            >
              <span>{friendlyTimestamp(s.connected ? s.startedAt : s.lastSeenAt)}</span>
              <span className="session-time-rel">
                {s.connected ? 'started' : 'last seen'} · {relative(s.connected ? s.startedAt : s.lastSeenAt)}
              </span>
            </div>
            {/* No panel links here: clicking the row opens the session, and the
                tabs are right there once you are inside. */}
            <div className="session-actions" onClick={(e) => e.stopPropagation()}>
              {trash ? (
                <>
                  <ToolbarButton title="Put this recording back in the list" onClick={() => restoreSession(s.sessionId)}>
                    ↩
                  </ToolbarButton>
                  <ToolbarButton title="Delete this recording for good" onClick={() => forgetSession(s.sessionId)}>
                    ✕
                  </ToolbarButton>
                </>
              ) : (
                /* A live page would say hello again within the second and take
                   the run straight back out of the trash, so wait for it to go. */
                <ToolbarButton
                  title={s.connected ? 'The page is still open; close it to move this to the trash' : 'Move to the trash'}
                  disabled={s.connected}
                  onClick={() => trashSession(s.sessionId)}
                >
                  ✕
                </ToolbarButton>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Long URLs (search pages, signed links) would otherwise fill the row and push
 * everything else out. Cut the middle, not the end: the origin says which site
 * it is and the tail usually says which page. The full URL is in the tooltip.
 */
function shortenUrl(url: string, max = 100): string {
  if (url.length <= max) return url;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${url.slice(0, head)}…${url.slice(-tail)}`;
}

/** Windows in the run, and how many still have a live agent. */
function windowCount(s: SessionMeta): number {
  return s.tabs?.length ?? 1;
}
function liveWindows(s: SessionMeta): number {
  return s.tabs?.filter((t) => t.connected).length ?? (s.connected ? 1 : 0);
}

/**
 * Through the relay's asset proxy, like every other resource of a debugged
 * page: the site may well be one this browser cannot reach, and after the
 * session ends the icon still comes from the recording.
 */
function Favicon({ url, sessionId }: { url: string; sessionId: string }) {
  const [failed, setFailed] = useState(false);
  let src = '';
  try {
    // No fallback: a list of recordings must not make this browser call on
    // every origin it has ever seen. Live sessions still fetch through the
    // page, and recorded ones show whatever the run already cached.
    src = assetPath(sessionId, `${new URL(url).origin}/favicon.ico`, { fallback: false });
  } catch {
    return <span className="session-favicon placeholder" />;
  }
  if (failed) return <span className="session-favicon placeholder" />;
  return <img className="session-favicon" src={src} alt="" onError={() => setFailed(true)} />;
}


function relative(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}
