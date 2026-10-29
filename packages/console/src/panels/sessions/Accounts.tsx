/**
 * Who can sign in to this relay: the list, one row's controls, and the form
 * that adds another.
 *
 * It is here because the alternative is an ssh session and the CLI, which is
 * a bad answer for the one task that comes up when somebody joins or leaves.
 */
import { useState } from 'react';
import type { AccountRole, AccountSummary } from '@bxconsole/protocol';
import { PASSWORD_MIN_LENGTH } from '@bxconsole/protocol';
import { createAccount, removeAccount, setAccountPassword, setAccountRole } from '../../transport/client';
import './AdminPanel.css';

export function Accounts({ accounts, loaded, meId }: { accounts: AccountSummary[]; loaded: boolean; meId: string }) {
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

/** One account, with the two things that can be done to it under its own row. */
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
          {isMe && <span className="tag admin-tag">you</span>}
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
