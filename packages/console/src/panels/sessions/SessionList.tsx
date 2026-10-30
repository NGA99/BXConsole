/**
 * The table of runs: a toolbar, a header that names the columns, and one row
 * per run — or per thing in the trash, which is the same table read as a
 * deadline rather than as a list of things to open.
 *
 * A row is a run, not a window: a run that opened other windows shows how
 * many it holds, and clicking it opens the run with those windows as tabs.
 */
import type { SessionMeta } from '@bxconsole/protocol';
import { purgeNote, purgeSummary } from './purge';
import { forgetSession, trashSession, restoreSession } from '../../transport/client';
import { navigate } from '../../app/router';
import { absoluteTimestamp, fullTimestamp } from '../../devtools-ui/time';
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarInput } from '../../devtools-ui/Toolbar';
import { plain } from '../../devtools-ui/plain-text';
import { Favicon } from './Favicon';
import { agentTitle, emptyReason, identity, liveWindows, relative, shortenUrl, windowCount } from './session-row';
import './SessionsPanel.css';

export function SessionList({
  trash,
  ordered,
  inView,
  purgeDays,
  query,
  setQuery,
  connectedOnly,
  setConnectedOnly,
  elsewhere,
  onInstall,
}: {
  trash: boolean;
  /** what is listed: this view's runs, filtered and sorted */
  ordered: SessionMeta[];
  /** this view's runs before the filter, so the toolbar can say what it hides */
  inView: SessionMeta[];
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
  /*
   * Everything the toolbar says is about what is listed, and the buttons act
   * on exactly that.
   *
   * It used to be of two minds. The count and the "Trash N recorded" button
   * read the whole project while the rows read the filter, so a list filtered
   * to six offered to trash twenty-one — and the trash view, one component
   * away, already did the opposite and scoped its own button to the filter.
   * One toolbar cannot answer the same question two ways, and of the two the
   * safe one is acting on what the reader can see.
   */
  const offline = sessions.filter((s) => !s.connected);
  const live = sessions.length - offline.length;
  const hidden = inView.length - sessions.length;
  /*
   * The two bulk buttons' titles, out here because each is three sentences
   * depending on one number and reads badly as a nested ternary.
   *
   * A button with nothing to act on explains itself rather than promising to
   * move "the 0 listed": it is disabled, so the only useful thing it can say
   * is why.
   */
  const hiding = `the ${hidden} the filter is hiding ${hidden === 1 ? 'stays' : 'stay'}`;
  let trashOfflineTitle: string;
  if (hidden === 0) trashOfflineTitle = `Move the recording of every session whose page is gone to the trash (${offline.length})`;
  else if (offline.length === 0) trashOfflineTitle = `Nothing listed has a page that is gone; ${hiding}`;
  else trashOfflineTitle = `Move the ${offline.length} listed whose page is gone to the trash; ${hiding}`;
  let deleteListedTitle: string;
  if (hidden === 0) deleteListedTitle = `Delete every recording in the trash for good (${sessions.length})`;
  else if (sessions.length === 0) deleteListedTitle = `Nothing is listed to delete; ${hiding}`;
  else deleteListedTitle = `Delete the ${sessions.length} listed for good; ${hiding}`;
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
        {/* What the filter is keeping back, so a narrowed count is not read as
            the whole project — and so the buttons beside it are read as
            acting on the smaller number, which they do. */}
        {hidden > 0 && <span className="sessions-count sessions-hidden-note">{hidden} hidden by the filter</span>}
        {trash && purgeSummary(purgeDays) && (
          <span className="sessions-count sessions-purge-note">{purgeSummary(purgeDays)}</span>
        )}
        <div style={{ flex: 1 }} />
        {trash ? (
          <ToolbarButton
            title={deleteListedTitle}
            disabled={sessions.length === 0}
            onClick={() => sessions.forEach((s) => forgetSession(s.sessionId))}
          >
            {/* Named for what it does: with a filter on it empties the
                listing, not the trash, and "Empty trash" would be a promise
                about rows that are not on screen. */}
            {hidden > 0 ? `Delete ${sessions.length} listed` : 'Empty trash'}
          </ToolbarButton>
        ) : (
          <ToolbarButton
            title={trashOfflineTitle}
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
            {/* Which of the four it is, in session-row: the branch had been
                reading the project when the reader is asking about the rows. */}
            {(() => {
              switch (emptyReason({ trash, hidden, elsewhere })) {
                case 'filtered':
                  return 'No session matches the filter.';
                case 'trash-empty':
                  return 'The trash is empty.';
                case 'elsewhere':
                  /*
                    Empty because of the project, not because the relay has
                    nothing. "No sessions yet" was shown either way, which on a
                    console holding three projects and two recordings reads as a
                    relay that has lost them.
                  */
                  return (
                    <>
                      Nothing recorded in this project yet — your other projects hold {elsewhere}{' '}
                      {elsewhere === 1 ? 'recording' : 'recordings'}.{' '}
                      <button className="sessions-link" onClick={onInstall}>Install the agent</button> to start one here.
                    </>
                  );
                case 'nothing-yet':
                  return (
                    <>
                      No sessions yet. <button className="sessions-link" onClick={onInstall}>Install the agent</button> in a page to start one.
                    </>
                  );
              }
            })()}
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
          <SessionRow key={s.sessionId} session={s} trash={trash} purgeDays={purgeDays} />
        ))}
      </div>
    </>
  );
}

/** One run, on one line. */
function SessionRow({ session: s, trash, purgeDays }: { session: SessionMeta; trash: boolean; purgeDays: number }) {
  return (
    <div
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
  );
}
