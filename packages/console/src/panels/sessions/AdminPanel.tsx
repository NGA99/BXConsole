/**
 * Accounts, and who owns which project.
 *
 * An administrator's screen, and the two things on it are deliberately the
 * only two. Adding and removing accounts is here because the alternative is
 * an ssh session and the CLI, which is a bad answer for the one task that
 * comes up when somebody joins or leaves. Reassigning a project is here
 * because removing an account leaves its projects behind with its id still on
 * them, and this is what clears that up.
 *
 * What is not here is reading anybody's recordings. An administrator who needs
 * the contents of a project takes it — which changes the owner, in a file —
 * rather than being quietly exempt from the check. That is why the projects
 * below arrive without their agent keys: listing them is not reading them.
 */
import { useEffect, useState } from 'react';
import type { AccountRole, AccountSummary, ProjectSummary } from '@bxconsole/protocol';
import { PASSWORD_MIN_LENGTH } from '@bxconsole/protocol';
import { useAdminStore } from '../../state/admin';
import { useAccount } from '../../state/whoami';
import {
  createAccount,
  listAdmin,
  removeAccount,
  setAccountPassword,
  setAccountRole,
  transferProject,
  restoreProject,
} from '../../transport/client';
import { absoluteTimestamp } from '../../devtools-ui/time';
import { purgeNote } from './purge';
import { useSessionsStore } from '../../state/sessions';
import './AdminPanel.css';

export function AdminPanel() {
  const { accounts, projects, loaded, error, clearError } = useAdminStore();
  const me = useAccount();

  // Asked for on arrival rather than held open: this is a screen somebody
  // opens, does one thing on, and leaves.
  useEffect(() => {
    if (me?.role === 'admin') listAdmin();
  }, [me?.role]);

  if (me?.role !== 'admin') {
    return (
      <div className="admin">
        <div className="admin-empty">
          This screen is for administrators. You are signed in as {me?.user ?? 'nobody'}.
        </div>
      </div>
    );
  }

  return (
    <div className="admin">
      {error && (
        <div className="admin-error">
          {error}
          <button className="detail-link" onClick={clearError}>
            dismiss
          </button>
        </div>
      )}
      <Accounts accounts={accounts} loaded={loaded} meId={me.id} />
      <Ownership projects={projects} accounts={accounts} loaded={loaded} />
    </div>
  );
}

function Accounts({ accounts, loaded, meId }: { accounts: AccountSummary[]; loaded: boolean; meId: string }) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AccountRole>('member');
  const admins = accounts.filter((a) => a.role === 'admin').length;

  const add = () => {
    if (!user.trim() || password.length < PASSWORD_MIN_LENGTH) return;
    createAccount(user.trim(), password, role);
    setUser('');
    setPassword('');
    setRole('member');
  };

  return (
    <section className="admin-section">
      <h2>Accounts</h2>
      <p className="admin-sub">
        Changes take effect at once — the relay re-reads its account file on its own, so nothing is
        restarted and no live run is dropped.
      </p>

      {!loaded ? (
        <div className="admin-empty">Loading…</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Id</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} isMe={a.id === meId} lastAdmin={a.role === 'admin' && admins === 1} />
            ))}
          </tbody>
        </table>
      )}

      <div className="admin-add">
        <input
          className="field"
          value={user}
          placeholder="name"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setUser(e.target.value)}
        />
        {/* Not a password field. Nothing here is masked: an operator setting
            somebody else's first password needs to read back what they are
            about to pass on, and a masked box makes that a guess. */}
        <input
          className="field"
          value={password}
          placeholder={`password (${PASSWORD_MIN_LENGTH}+ characters)`}
          spellCheck={false}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        {/* Three unlabelled dropdowns on one screen, each reading as its own
            value: "admin", "member", "admin". What they are for is only in
            the column they sit under, which a reader going control by
            control never sees. */}
        <select aria-label="Role for the new account" value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button className="detail-link" disabled={!user.trim() || password.length < PASSWORD_MIN_LENGTH} onClick={add}>
          add account
        </button>
      </div>
    </section>
  );
}

function AccountRow({
  account,
  isMe,
  lastAdmin,
}: {
  account: AccountSummary;
  isMe: boolean;
  lastAdmin: boolean;
}) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <>
      <tr>
        <td>
          {account.user}
          {isMe && <span className="admin-tag">you</span>}
        </td>
        <td>
          <select
            aria-label={`Role for ${account.user}`}
            value={account.role}
            disabled={lastAdmin}
            title={lastAdmin ? 'The last administrator; make another one first' : undefined}
            onChange={(e) => setAccountRole(account.user, e.target.value as AccountRole)}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </td>
        <td className="mono admin-id" title="What the projects this account owns are owned by">
          {account.id}
        </td>
        <td className="admin-row-actions">
          <button className="detail-link" onClick={() => (setResetting((v) => !v), setPassword(''))}>
            {resetting ? 'cancel' : 'set password'}
          </button>
          {!lastAdmin &&
            (confirmRemove ? (
              <>
                <button className="detail-link bad" onClick={() => removeAccount(account.user)}>
                  remove “{account.user}”
                </button>
                <button className="detail-link" onClick={() => setConfirmRemove(false)}>
                  cancel
                </button>
              </>
            ) : (
              <button className="detail-link bad" onClick={() => setConfirmRemove(true)}>
                remove
              </button>
            ))}
        </td>
      </tr>
      {resetting && (
        <tr>
          <td colSpan={4} className="admin-reset">
            <input
              className="field"
              autoFocus
              value={password}
              placeholder={`new password for ${account.user} (${PASSWORD_MIN_LENGTH}+ characters)`}
              spellCheck={false}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password.length >= PASSWORD_MIN_LENGTH) {
                  setAccountPassword(account.user, password);
                  setResetting(false);
                }
                if (e.key === 'Escape') setResetting(false);
              }}
            />
            <button
              className="detail-link"
              disabled={password.length < PASSWORD_MIN_LENGTH}
              onClick={() => (setAccountPassword(account.user, password), setResetting(false))}
            >
              set it
            </button>
            <span className="admin-sub">
              Every browser signed in as {account.user} is signed out, because the cookie is derived
              from the stored password.
            </span>
          </td>
        </tr>
      )}
      {confirmRemove && (
        <tr>
          <td colSpan={4} className="admin-sub admin-reset">
            Their projects stay where they are, still owned by {account.id}. Reassign them below.
          </td>
        </tr>
      )}
    </>
  );
}

function Ownership({
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
                        <span className="admin-tag bad" title={`Deleted on ${new Date(p.trashedAt).toISOString()}`}>
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
