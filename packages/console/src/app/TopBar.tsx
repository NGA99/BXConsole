/**
 * The window's title bar: the one row that should look the same wherever you
 * are.
 *
 * It used to be written out twice, once for the session list and once for an
 * open session, and the two drifted apart. The list kept the relay status
 * tucked beside the wordmark while the session pushed it to the far right,
 * and the session dropped the wordmark altogether — so moving between the two
 * views rearranged the bar under you. One component holds the shape now, and
 * a view supplies only the navigation that is its own.
 *
 * The three things that draw into it — the project, the run, the account —
 * are each a file beside this one. They were in Shell.tsx and in a file named
 * after a bar that no longer exists, which is how a row of four pieces came
 * to live in three places.
 */
import type { ReactNode } from 'react';
import './TopBar.css';

export type Theme = 'system' | 'light' | 'dark';

export function TopBar({
  relayUp,
  theme,
  onCycleTheme,
  children,
  trailing,
}: {
  relayUp: boolean;
  theme: Theme;
  onCycleTheme: () => void;
  children?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="topbar">
      <span className="topbar-title">BXConsole</span>
      {children}
      <div className="topbar-spacer" />
      {trailing}
      <span className={`relay-status ${relayUp ? 'on' : 'off'}`}>
        {relayUp ? 'relay connected' : 'relay disconnected'}
      </span>
      <button className="topbar-theme" title={`Theme: ${theme} (click to change)`} onClick={onCycleTheme}>
        {theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}
      </button>
    </div>
  );
}
