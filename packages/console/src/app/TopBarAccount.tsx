/** Who is signed in, and the way to the relay's accounts. Right of the title row. */
import { useAccount, useIsAdmin } from '../state/whoami';
import { navigateToView } from './router';
import './TopBar.css';

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
