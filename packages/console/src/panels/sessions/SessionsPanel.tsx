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
import { useSessionList, useSessionsStore } from '../../state/sessions';
import { purgeNote, purgeSummary } from './purge';
import { forgetSession, trashSession, restoreSession } from '../../transport/client';
import { navigate, navigateToView, type SessionView } from '../../app/router';
import { absoluteTimestamp, fullTimestamp } from '../../devtools-ui/time';
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarInput } from '../../devtools-ui/Toolbar';
import { TabBar } from '../../devtools-ui/TabBar';
import { AgentPanel } from './AgentPanel';
import { WebhookPanel } from './WebhookPanel';
import { ProjectBar } from './ProjectBar';
import { ProjectsPanel } from './ProjectsPanel';
import { AdminPanel } from './AdminPanel';
import { useProjectsStore } from '../../state/projects';
import { plain } from '../../devtools-ui/plain-text';
import { SiteIcon } from '../../devtools-ui/icons';
import './SessionsPanel.css';

export function SessionsPanel({ view }: { view: SessionView }) {
  const everything = useSessionList();
  const purgeDays = useSessionsStore((s) => s.trashPurgeDays);
  const { selectedId, homeId, order, loaded: projectsLoaded } = useProjectsStore();
  const setView = navigateToView;
  const [query, setQuery] = useState('');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const q = query.trim().toLowerCase();
  /*
   * One project at a time.
   *
   * A run with no project of its own is in the home one — that is how the
   * relay reads it, and the list has to agree or those recordings would
   * belong to no project here and show up nowhere. Where there is no project
   * list at all the relay has sent no sessions either, so filtering to
   * nothing is the same answer arrived at twice.
   */
  const all = order.length === 0 ? everything : everything.filter((s) => (s.projectId ?? homeId) === selectedId);
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

  /*
   * Projects are a level up, not a tab beside the others.
   *
   * Sessions, Webhook, Trash and Agent are all about one project: its runs,
   * what reaches it, what it has thrown away, and the snippet carrying its
   * key. Projects is where you choose which — and having it sit among them
   * made it read as a fifth thing to look at, with two ways to change
   * project and no sense of being inside one. Admin is a level up too: it is
   * the relay's accounts, not this project's.
   */
  const inside = view !== 'projects' && view !== 'admin';
  /*
   * With no project there is nothing for these four tabs to be about: no
   * runs to list, nothing in a trash, and a snippet with no key in it. So
   * the list is what is shown, which is also the one thing there is to do.
   * Only once the relay has said — before that an empty list means "not
   * yet", and showing "you have no projects" for a moment on every
   * connection would be worse than waiting.
   */
  const nothingToBeIn = inside && projectsLoaded && order.length === 0;

  return (
    <>
      <ProjectBar showing={nothingToBeIn || view === 'projects' ? 'projects' : view === 'admin' ? 'admin' : 'inside'} />
      {inside && !nothingToBeIn && (
        <TabBar
          tabs={[
            { id: 'sessions', label: live > 0 ? `Sessions (${live} live)` : 'Sessions' },
            { id: 'webhook', label: 'Webhook' },
            { id: 'trash', label: trashed.length > 0 ? `Trash (${trashed.length})` : 'Trash' },
            { id: 'agent', label: 'Agent' },
          ]}
          active={view}
          onSelect={setView}
          /*
           * The way out sits in the tab row, divided off from it.
           *
           * It was a blue word in the thin row above, and QA rounds showed
           * people scanning the tabs and reading that row as decoration. A
           * tab is what they look at, so this is shaped like one — but it
           * leaves the project rather than choosing a view inside it, so it
           * keeps the arrow, the border and the divider, and never takes the
           * selected underline the four beside it use.
           */
          leading={
            <div className="tabbar-leading">
              <button
                className="tabbar-up"
                title="Every project you can read"
                onClick={() => navigateToView('projects')}
              >
                ← Projects
              </button>
            </div>
          }
        />
      )}
      {nothingToBeIn ? (
        <ProjectsPanel />
      ) : view === 'webhook' ? (
        <WebhookPanel />
      ) : view === 'agent' ? (
        <div className="sessions-list">
          <AgentPanel onDiagnose={() => setView('webhook')} />
        </div>
      ) : view === 'projects' ? (
        <ProjectsPanel />
      ) : view === 'admin' ? (
        <AdminPanel />
      ) : (
        <SessionList
          trash={view === 'trash'}
          ordered={ordered}
          all={all}
          offline={offline}
          live={live}
          purgeDays={purgeDays}
          elsewhere={everything.length - all.length}
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
  purgeDays,
  query,
  setQuery,
  connectedOnly,
  setConnectedOnly,
  elsewhere,
  onInstall,
}: {
  trash: boolean;
  ordered: SessionMeta[];
  all: SessionMeta[];
  offline: SessionMeta[];
  live: number;
  /** days something stays in the trash before it is deleted; 0 means never */
  purgeDays: number;
  /** recordings this account has in its other projects, for the empty state */
  elsewhere: number;
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
        {trash && purgeSummary(purgeDays) && (
          <span className="sessions-count sessions-purge-note">{purgeSummary(purgeDays)}</span>
        )}
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
            ) : all.length > 0 ? (
              'No session matches the filter.'
            ) : elsewhere > 0 ? (
              /*
                Empty because of the project, not because the relay has
                nothing. "No sessions yet" was shown either way, which on a
                console holding three projects and two recordings reads as a
                relay that has lost them.
              */
              <>
                Nothing recorded in this project yet — your other projects hold {elsewhere}{' '}
                {elsewhere === 1 ? 'recording' : 'recordings'}.{' '}
                <button className="sessions-link" onClick={onInstall}>Install the agent</button> to start one here.
              </>
            ) : (
              <>
                No sessions yet. <button className="sessions-link" onClick={onInstall}>Install the agent</button> in a page to start one.
              </>
            )}
          </div>
        )}
        {/* The header is what makes this a table rather than a wall of text:
            it names the two columns that are otherwise guesswork, and it is
            the only thing standing between the reader and a row of numbers.
            Hidden with an empty list, where it would label nothing. */}
        {sessions.length > 0 && (
          <div className="session-row session-head" aria-hidden="true">
            <span />
            <span />
            <span>Session</span>
            <span>URL</span>
            {/* Each header cell carries its column's class, so a breakpoint
                that hides the column takes its label with it. */}
            <span className="session-ua">User agent</span>
            <span className="session-windows-cell">Tab</span>
            <span className="session-started">Started</span>
            <span className="session-when">{trash && purgeDays > 0 ? 'Deleted' : 'Activity'}</span>
            <span />
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
            {/* The page title and the session id used to have columns of their
                own. One line per session has no room for them, and they are
                the two that are least often what you are scanning for, so they
                moved into the tooltip rather than off the screen. The filter
                still searches both. */}
            <span className="session-name" title={identity(s)}>
              {plain(s.name ?? s.title) ?? '(untitled)'}
            </span>
            <span className="session-url mono" title={plain(s.url)}>
              {plain(shortenUrl(s.url))}
            </span>
            {/* The user agent as the browser sent it.
                This used to be parsed down to "Chrome 152", which threw away
                the thing you came for. A run recorded through Claude's in-app
                browser sends `… Claude/2.42304.0 Chrome/152.0.7977.149 …` and
                read as plain Chrome, because the token that said otherwise was
                not one the parser knew — and a parser can only ever know the
                tokens that existed when it was written.

                It is cut from the left, which is the whole reason this fits on
                one line. Every user agent opens with the same fifty characters
                of boilerplate and carries what distinguishes it at the end, so
                truncating the usual way fills the column and says nothing. The
                <bdi> keeps the text itself reading left to right inside the
                right-to-left box that moves the ellipsis; without it, a string
                ending in `)` renders with the bracket at the front. */}
            <span className="session-ua mono" title={agentTitle(s)}>
              <bdi>{s.userAgent || 'no user agent reported'}</bdi>
            </span>
            {/* Always a count, even for the ordinary one-window run.
                It used to appear only above one window, which left a hole in
                the column on most rows and made the badge read as a warning
                rather than a fact. A single run reads `0/1` or `1/1` — not
                `0/0`, which would say the payload never opened a window. */}
            <span className="session-windows-cell">
              <span
                className="session-windows"
                title={
                  windowCount(s) === 1
                    ? `One window, ${liveWindows(s) === 1 ? 'still open' : 'closed'}`
                    : `${windowCount(s)} windows in this run, ${liveWindows(s)} still open`
                }
              >
                {liveWindows(s)}/{windowCount(s)}
              </span>
            </span>
            {/* When the payload fired, on the clock.
                A relative age answers "is this still warm", which is what you
                scan a list for, but it is useless for the thing this tool is
                for: lining a run up against a request log, a ticket, or what
                somebody says they were doing at the time. That needs a
                timestamp, so both are here rather than one of them in a
                tooltip nobody hovers. */}
            <span className="session-started" title={`Agent installed at ${fullTimestamp(s.startedAt)}`}>
              {absoluteTimestamp(s.startedAt)}
            </span>
            {/* A live run is dated from when it fired, which is the fact worth
                having; a dead one from its last event, which is when it
                stopped being worth watching. The tooltip says which, since one
                column cannot. */}
            {/* In the trash the useful date is not the traffic but the
                deadline: leaving it here is itself an action, and in a week
                it is gone with nobody to ask. */}
            {trash && purgeDays > 0 ? (
              <span
                className="session-when session-purge"
                title={`Moved to the trash at ${fullTimestamp(s.trashedAt ?? s.lastSeenAt)}\nPut it back to keep it`}
              >
                {purgeNote(s.trashedAt, purgeDays)}
              </span>
            ) : (
              <span
                className="session-when"
                title={
                  s.connected
                    ? `Still connected\nLast event at ${fullTimestamp(s.lastSeenAt)}`
                    : `Last event at ${fullTimestamp(s.lastSeenAt)}`
                }
              >
                {relative(s.connected ? s.startedAt : s.lastSeenAt)}
              </span>
            )}
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
/** Everything the row calls this session, for the tooltip the name carries. */
function identity(s: SessionMeta): string {
  return [plain(s.name), plain(s.title), `session-${s.sessionId}`].filter(Boolean).join('\n');
}

/**
 * The user agent, plus the viewport under it.
 *
 * The viewport is not in the user agent and is worth knowing — a 390-wide
 * window is a phone whatever the string claims. It had a column of its own
 * until the row became one line. Zero is what a recording made before the
 * window reported its size looks like, and "0×0" would state something false.
 */
function agentTitle(s: SessionMeta): string {
  const size = s.viewport.width > 0 && s.viewport.height > 0 ? `${s.viewport.width}×${s.viewport.height}` : null;
  return [s.userAgent || 'no user agent reported', size].filter(Boolean).join('\n');
}

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
    return <NoFavicon />;
  }
  if (failed) return <NoFavicon />;
  // contain, so a site whose icon is not square is shown as it is rather than
  // squashed into the 16px box.
  return <img className="session-favicon" src={src} alt="" onError={() => setFailed(true)} />;
}


/** No icon of its own, which is the ordinary case for a recorded run. */
function NoFavicon() {
  return (
    <span className="session-favicon placeholder">
      <SiteIcon />
    </span>
  );
}

function relative(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  // absoluteTimestamp, not the locale: a column is read against a server
  // log, and this one sits under rows that say "3m ago" in English.
  return absoluteTimestamp(ts);
}
