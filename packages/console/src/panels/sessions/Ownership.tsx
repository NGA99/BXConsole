/**
 * Every project on this relay and who owns it — and the only place a deleted
 * one can be put back.
 *
 * Handing a project over is how an administrator reaches one they do not own,
 * and it is written down rather than being a read nobody can see. Agent keys
 * are not listed: listing a project is not reading it.
 */
import type { AccountSummary, ProjectSummary } from '@bxconsole/protocol';
import { transferProject, restoreProject } from '../../transport/client';
import { absoluteTimestamp } from '../../devtools-ui/time';
import { purgeNote } from './purge';
import { useSessionsStore } from '../../state/sessions';
import './AdminPanel.css';

export function Ownership({
  projects,
  accounts,
  loaded,
}: {
  projects: ProjectSummary[];
  accounts: AccountSummary[];
  loaded: boolean;
}) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // The same window the relay applies, read from where it is already sent.
  const purgeDays = useSessionsStore((st) => st.trashPurgeDays);
  /*
   * A project whose owner is not an account any more.
   *
   * What removing an account leaves behind: the project keeps the id it was
   * owned by, so nobody can read it and nothing says why. These are the rows
   * this screen exists for, so they are listed first and marked.
   */
  const ordered = [...projects].sort((a, b) => Number(byId.has(a.owner)) - Number(byId.has(b.owner)));

  return (
    <section className="admin-section">
      <h2>Who owns what</h2>
      <p className="admin-sub">
        Every project on this relay. Handing one over is how an administrator reaches a project they
        do not own, and it is written down rather than being a read nobody can see. Agent keys are
        not listed here: a key records into the engagement it belongs to.
      </p>

      {!loaded ? (
        <div className="admin-empty">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="admin-empty">No projects yet.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Recordings</th>
              <th>Made</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((p) => {
              const owner = byId.get(p.owner);
              return (
                <tr key={p.id} className={owner ? undefined : 'admin-orphan'}>
                  {/*
                    * A deleted project, and the one way back.
                    *
                    * Deleting is immediate for the owner — it leaves their
                    * screen at once — so these seven days are only reachable
                    * from here. Putting one back hands nothing over: it
                    * returns to the owner it already had, and an
                    * administrator who wants to read it still has to take it
                    * with the owner field below, where that shows.
                    */}
                  <td>
                    {p.name}
                    {p.trashedAt !== undefined && (
                      <>
                        <span className="tag admin-tag bad" title={`Deleted on ${new Date(p.trashedAt).toISOString()}`}>
                          {purgeNote(p.trashedAt, purgeDays) ?? 'deleted'}
                        </span>
                        <button className="detail-link" onClick={() => restoreProject(p.id)}>
                          put it back
                        </button>
                      </>
                    )}
                  </td>
                  <td>{p.sessions}</td>
                  <td title={new Date(p.createdAt).toISOString()}>{absoluteTimestamp(p.createdAt)}</td>
                  <td>
                    <select
                      aria-label={`Owner of ${p.name}`}
                      value={owner ? p.owner : ''}
                      onChange={(e) => e.target.value && transferProject(p.id, e.target.value)}
                    >
                      {!owner && <option value="">no account ({p.owner})</option>}
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.user}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
