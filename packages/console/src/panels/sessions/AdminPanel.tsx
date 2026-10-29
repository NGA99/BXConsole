/**
 * Accounts, and who owns which project.
 *
 * An administrator's screen, and the two things on it are deliberately the
 * only two — one section each, in a file each beside this one. Adding and
 * removing accounts is here because the alternative is an ssh session and the
 * CLI, which is a bad answer for the one task that comes up when somebody
 * joins or leaves. Reassigning a project is here because removing an account
 * leaves its projects behind with its id still on them, and this is what
 * clears that up.
 *
 * What is not here is reading anybody's recordings. An administrator who needs
 * the contents of a project takes it — which changes the owner, in a file —
 * rather than being quietly exempt from the check. That is why the projects
 * below arrive without their agent keys: listing them is not reading them.
 */
import { useEffect } from 'react';
import { useAdminStore } from '../../state/admin';
import { useAccount } from '../../state/whoami';
import { listAdmin } from '../../transport/client';
import { Accounts } from './Accounts';
import { Ownership } from './Ownership';
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
