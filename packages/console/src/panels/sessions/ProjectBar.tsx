/**
 * Where you are, said on the title row — and the notice when it goes away.
 *
 * The bar this file is named after is gone. It drew `Projects / NC` and then
 * `Projects | Sessions` and then the windows, each screen a slightly
 * different row, which is the drift ProjectTabs exists to end: the tabs are
 * one row built once, the windows are the browser block's, and what is left
 * here is the project's name beside the console's, who is signed in, and the
 * one thing that has to interrupt.
 */
import { useProjectsStore } from '../../state/projects';
import { useSessionList } from '../../state/sessions';
import { useAccount, useIsAdmin } from '../../state/whoami';
import { navigateToView, type SessionView } from '../../app/router';
import { plain } from '../../devtools-ui/plain-text';
import './ProjectBar.css';

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
export function LostNotice() {
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


/**
 * The project, on the title row: `BXConsole | NC`.
 *
 * It used to have a row of its own between the title and the tabs, which was
 * a whole row saying one word. On the title row it reads as what it is — the
 * thing the window is currently about — and the row it vacated is gone.
 *
 * @param sessionId  when a run is open, the project named is the one that run
 *                   is in rather than whichever the list was last left on;
 *                   those differ as soon as a session is opened from the
 *                   picker and belongs somewhere else.
 * @param view       which list screen is showing, so the two that are not
 *                   inside a project can say so by naming none. The Projects
 *                   screen is the one above every project and Admin is beside
 *                   them all; naming the one the list happened to be left on
 *                   claimed you were in it.
 */
export function TopBarProject({ sessionId, view }: { sessionId?: string; view?: SessionView }) {
  const outside = !sessionId && (view === 'projects' || view === 'admin');
  const { byId, homeId, selectedId } = useProjectsStore();
  const sessions = useSessionList();
  const open = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined;
  const currentId = sessionId ? open?.projectId ?? homeId : selectedId;
  const project = currentId ? byId[currentId] : undefined;
  if (!project || outside) return null;
  return (
    <>
      <span className="topbar-sep">›</span>
      <span className="topbar-crumb" title={project.name}>
        {plain(project.name)}
      </span>
    </>
  );
}

/** Who is signed in, and the way to the relay's accounts. Right of the title row. */
export function TopBarAccount() {
  const account = useAccount();
  const isAdmin = useIsAdmin();
  return (
    <>
      {isAdmin && (
        <button
          className="topbar-link"
          title="Accounts, and who owns which project"
          onClick={() => navigateToView('admin')}
        >
          Admin
        </button>
      )}
      {account && (
        <span
          className="topbar-who"
          title={
            account.role === 'admin'
              ? 'An administrator: can add accounts and reassign projects'
              : 'A member: owns projects, and reads what is shared with them'
          }
        >
          {account.user}
        </span>
      )}
    </>
  );
}
