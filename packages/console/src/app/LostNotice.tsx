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
import { useProjectsStore } from '../state/projects';
import './LostNotice.css';

export function LostNotice() {
  const lost = useProjectsStore((s) => s.lost);
  const clear = useProjectsStore((s) => s.clearLost);
  if (!lost) return null;
  return (
    <div className="lost-notice" role="status">
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
