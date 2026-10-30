/**
 * Sessions tab: which of the project's screens you are on, and the filtering
 * the list of runs needs.
 *
 * The table itself is SessionList, beside this file; the rest of the screens
 * are their own panels already. What is left here is the choice between them
 * and the state the list is read through — the project filter, the text
 * query, connected-only — which is why it stays with the chooser rather than
 * going into the table.
 */
import { useState } from 'react';
import { useSessionList, useSessionsStore } from '../../state/sessions';
import { navigateToView, type SessionView } from '../../app/router';
import { ProjectTabs } from './ProjectTabs';
import { AgentPanel } from './AgentPanel';
import { WebhookPanel } from './WebhookPanel';
import { LostNotice } from '../../app/LostNotice';
import { ProjectsPanel } from './ProjectsPanel';
import { AdminPanel } from './AdminPanel';
import { SessionList } from './SessionList';
import { useProjectsStore } from '../../state/projects';
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
  /*
   * What this view is about before the filter touches it. The table counts
   * and acts on what it lists, and needs this only to say how much the
   * filter is holding back.
   */
  const inView = view === 'trash' ? trashed : kept;
  const sessions = inView.filter((s) => {
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
      <LostNotice />
      {/* The same row every screen draws; see ProjectTabs for why it is one. */}
      <ProjectTabs active={view} />
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
          inView={inView}
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
