/**
 * Which project this console is looking at.
 *
 * Above the tabs rather than inside one, because it is not a view: it scopes
 * every one of them. The session list shows this project's runs, and the
 * snippet in the Agent tab carries this project's key — one thing to change
 * instead of two to keep in step.
 *
 * One project at a time, with no "all" option. A key belongs to one project,
 * so a list spanning several would be a list you cannot make a payload for;
 * the counts beside each name are what tells you where the activity is
 * without having to click through.
 */
import { useProjectsStore } from '../../state/projects';
import { useSessionList } from '../../state/sessions';
import { useAccount } from '../../state/whoami';
import { selectProject } from '../../state/projects';
import { navigateToView } from '../../app/router';
import './ProjectBar.css';

export function ProjectBar() {
  const { order, byId, homeId, selectedId } = useProjectsStore();
  const account = useAccount();
  const sessions = useSessionList();

  // Nothing to switch between, and nothing worth a row of chrome saying so.
  // The Projects view is where "you have none, make one" belongs.
  if (order.length === 0) return null;

  /** Live and recorded runs in each project, home standing in for none. */
  const counts = new Map<string, { live: number; kept: number }>();
  for (const s of sessions) {
    const id = s.projectId ?? homeId;
    if (!id) continue;
    const at = counts.get(id) ?? { live: 0, kept: 0 };
    if (s.connected) at.live++;
    else at.kept++;
    counts.set(id, at);
  }

  const label = (id: string): string => {
    const project = byId[id];
    if (!project) return id;
    const at = counts.get(id);
    const live = at?.live ? `${at.live} live` : '';
    const kept = at?.kept ? `${at.kept} recorded` : '';
    const both = [live, kept].filter(Boolean).join(' · ');
    const trashed = project.trashedAt !== undefined ? ' — in the trash' : '';
    return `${project.name}${both ? ` (${both})` : ''}${trashed}`;
  };

  return (
    <div className="projectbar">
      <label className="projectbar-pick">
        Project{' '}
        <select value={selectedId} onChange={(e) => selectProject(e.target.value)}>
          {order.map((id) => (
            <option key={id} value={id}>
              {label(id)}
            </option>
          ))}
        </select>
      </label>
      <button className="detail-link" onClick={() => navigateToView('projects')}>
        manage
      </button>
      <div className="projectbar-spacer" />
      {account && (
        <span className="projectbar-who" title={account.role === 'admin' ? 'An administrator: can add accounts and reassign projects' : 'A member: owns projects, and reads what is shared with them'}>
          {account.user}
          {account.role === 'admin' && <span className="projectbar-role">admin</span>}
        </span>
      )}
    </div>
  );
}
