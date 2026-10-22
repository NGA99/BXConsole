/**
 * Where you are, and the way back out.
 *
 * Projects are a level above Sessions, Webhook, Trash and Agent — those four
 * are all about one project, and this says which. It used to be a switcher
 * beside a Projects tab, which gave two ways to change project and no sense
 * of being inside one; it reads as a path now, with the list at its root.
 *
 * The dropdown stays, because going out to the list and back in is three
 * clicks for something somebody does all day. It is the shortcut, not the
 * only route: everything it does, the Projects screen does as well.
 */
import { useProjectsStore, selectProject } from '../../state/projects';
import { useSessionList } from '../../state/sessions';
import { useAccount, useIsAdmin } from '../../state/whoami';
import { navigateToView } from '../../app/router';
import './ProjectBar.css';

/** Which of the three things is on screen, which is not always the route. */
export type Showing = 'projects' | 'admin' | 'inside';

export function ProjectBar({ showing }: { showing: Showing }) {
  const { order, byId, homeId, selectedId } = useProjectsStore();
  const account = useAccount();
  const isAdmin = useIsAdmin();
  const sessions = useSessionList();
  const inside = showing === 'inside';
  const current = selectedId ? byId[selectedId] : undefined;

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
    const both = [at?.live ? `${at.live} live` : '', at?.kept ? `${at.kept} recorded` : ''].filter(Boolean).join(' · ');
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
      {inside && current && (
        <>
          <span className="projectbar-sep">/</span>
          <select
            className="projectbar-pick"
            value={selectedId}
            title="The project these tabs are about"
            onChange={(e) => selectProject(e.target.value)}
          >
            {order.map((id) => (
              <option key={id} value={id}>
                {label(id)}
              </option>
            ))}
          </select>
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
