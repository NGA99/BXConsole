/**
 * Where you are, and the way back out.
 *
 * Projects are a level above Sessions, Webhook, Trash and Agent — those four
 * are all about one project, and this says which. It used to be a switcher
 * beside a Projects tab, which gave two ways to change project and no sense
 * of being inside one; it reads as a path now, with the list at its root.
 *
 * There is no project switcher in the path. The one that was here — a
 * dropdown on the current crumb — was a second door onto the Projects list,
 * which the root a click to the left already opens, and which shows every
 * project's counts besides. A breadcrumb switches nothing: its last crumb is
 * where you stand, and its earlier ones are the way back out.
 */
import { useProjectsStore, selectProject } from '../../state/projects';
import { useSessionList } from '../../state/sessions';
import { useAccount, useIsAdmin } from '../../state/whoami';
import { navigateToView, type PanelId } from '../../app/router';
import { SessionPicker } from '../../app/SessionPicker';
import { projectCounts, describeCount } from './project-counts';
import './ProjectBar.css';

/** Which of the three things is on screen, which is not always the route. */
export type Showing = 'projects' | 'admin' | 'inside';

/**
 * @param session  the run being read, when one is open. A session is inside a
 *                 project, so it belongs at the end of this path — it used to
 *                 sit up in the title bar instead, which left the path
 *                 stopping at the project while the thing you were actually
 *                 looking at was named a row above it.
 */
export function ProjectBar({ showing, session }: { showing: Showing; session?: { id: string; panel: PanelId } }) {
  const { byId, homeId, selectedId } = useProjectsStore();
  const account = useAccount();
  const isAdmin = useIsAdmin();
  const sessions = useSessionList();
  const inside = showing === 'inside';
  /*
   * Which project the path is about.
   *
   * With a session open that is the project the run is in, not whichever one
   * the list was last left on: those differ as soon as somebody opens a
   * session from the picker and it belongs somewhere else, and a path that
   * named the wrong project would be worse than no path.
   */
  const open = session ? sessions.find((s) => s.sessionId === session.id) : undefined;
  const currentId = session ? open?.projectId ?? homeId : selectedId;
  const current = currentId ? byId[currentId] : undefined;

  const counts = projectCounts(sessions, homeId);

  const label = (id: string): string => {
    const project = byId[id];
    if (!project) return id;
    const both = describeCount(counts.get(id));
    const trashed = project.trashedAt !== undefined ? ' — in the trash' : '';
    return `${project.name}${both ? ` (${both})` : ''}${trashed}`;
  };

  return (
    <>
      <LostNotice />
      <div className="projectbar">
      <button
        className={`projectbar-root${showing === 'projects' ? ' here' : ''}`}
        title="Every project you can read"
        onClick={() => navigateToView('projects')}
      >
        Projects
      </button>

      {/* Only inside one. On the list itself there is no "where you are" to
          say, and a name beside the root would read as a second heading. */}
      {inside && current && currentId && (
        <>
          <span className="projectbar-sep">/</span>
          {/* With a session open the project is the way back to its runs, so
              it is a link like the root above it. The dropdown is the list's:
              switching project from inside one session means leaving it, and
              a control that quietly did that would be a surprise. */}
          {session ? (
            <button
              className="projectbar-root projectbar-name"
              // The name as well as what clicking does: it is capped here, so
              // a long one is read by hovering or nowhere.
              title={`${label(currentId)}\nThe runs in this project`}
              onClick={() => {
                selectProject(currentId);
                navigateToView('sessions');
              }}
            >
              {label(currentId)}
            </button>
          ) : (
            // The list view: this is where you already are, so the crumb
            // names the project without offering to switch it. A dropdown
            // used to sit here; it only reopened the Projects list, which the
            // root to the left already does.
            <span className="projectbar-name projectbar-current" title="The project these tabs are about">
              {label(currentId)}
            </span>
          )}
        </>
      )}

      {session && (
        <>
          <span className="projectbar-sep">/</span>
          <SessionPicker sessionId={session.id} panel={session.panel} />
        </>
      )}

      <div className="projectbar-spacer" />
      {isAdmin && (
        <button
          className={`projectbar-root${showing === 'admin' ? ' here' : ''}`}
          title="Accounts, and who owns which project"
          onClick={() => navigateToView('admin')}
        >
          Admin
        </button>
      )}
      {account && (
        <span
          className="projectbar-who"
          title={
            account.role === 'admin'
              ? 'An administrator: can add accounts and reassign projects'
              : 'A member: owns projects, and reads what is shared with them'
          }
        >
          {account.user}
        </span>
      )}
      </div>
    </>
  );
}

/**
 * The project you were reading is not yours to read any more.
 *
 * The console recovers from this on its own — it falls back to another
 * project and goes on working — which is the problem: somebody who looked
 * away comes back to a different engagement's recordings with nothing to say
 * the one they had is gone. It happens when an administrator hands a project
 * on, and when one that was in the trash is purged.
 *
 * Not said to whoever caused it: a console that asked for a project to be
 * deleted already knows.
 */
function LostNotice() {
  const lost = useProjectsStore((s) => s.lost);
  const clear = useProjectsStore((s) => s.clearLost);
  if (!lost) return null;
  return (
    <div className="projectbar-lost" role="status">
      <span>
        <strong>{lost.name}</strong>{' '}
        {lost.reason === 'transferred'
          ? 'now belongs to somebody else, so you can no longer read it.'
          : 'has been deleted, along with its recordings.'}
        {lost.landedOn ? <> You are now in <strong>{lost.landedOn}</strong>.</> : ' You have no other project.'}
      </span>
      <button className="detail-link" onClick={clear}>
        dismiss
      </button>
    </div>
  );
}
