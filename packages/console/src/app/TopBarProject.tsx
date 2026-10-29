/**
 * The project, on the title row: `BXConsole › NC`.
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
import { useProjectsStore } from '../state/projects';
import { useSessionList } from '../state/sessions';
import { plain } from '../devtools-ui/plain-text';
import type { SessionView } from './router';
import './TopBar.css';

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
