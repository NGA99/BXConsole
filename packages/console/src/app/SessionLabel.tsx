/**
 * Which run the window is showing, on the title row.
 *
 * It used to be a dropdown that switched sessions. Two things were wrong with
 * that. The title row says what you are looking at, and a control sitting in
 * the middle of it drew the eye and wore a focus ring across the identity.
 * And it was a second door onto the session list, which the Sessions button
 * one row down already opens — with a filter, the urls and the times, which
 * a menu of names cannot give you.
 *
 * The segments are divided by a chevron. Names here come from the
 * engagement — a project called "NC / Do not delete!", a run called
 * `o'brien & sons <x> "q" (a)` — so a name can hold the same character the
 * divider uses. `›` is not `>`, and the dividers are drawn in the subtle ink
 * while the names keep the plain one, which is what tells them apart.
 *
 * The address is not here any more, nor the connection dot. Both belong to
 * one window rather than to the run, and both now sit in the browser block's
 * address bar, where the window they describe is the tab directly above them.
 * This row is left saying only where you are: the console, the project, the
 * run.
 */
import { useSessionList } from '../state/sessions';
import { useActiveTab } from '../state/active-tab';
import { plain } from '../devtools-ui/plain-text';

export function SessionLabel({ sessionId }: { sessionId: string }) {
  const sessions = useSessionList();
  const current = sessions.find((s) => s.sessionId === sessionId);

  const label = plain(current ? current.name ?? current.title ?? current.sessionId : `session-${sessionId}`);
  // The windows are tabs in the browser block below; this names the one
  // selected, on the rare occasion its tab is too narrow to.
  const activeTab = useActiveTab(sessionId);
  const tab = current?.tabs?.find((t) => t.tabId === activeTab);
  /*
   * The selected window's own title, spelled out here because its tab cannot.
   *
   * A tab is 180px and a title is whatever the page calls itself, so
   * "쇼핑몰 — 주문 확인 페이지" arrives as "쇼핑몰 — 주문 확…" and there was
   * nowhere to read the rest short of hovering. Only when there is a strip to
   * have truncated it, and only when it says something the run's own name
   * does not — a one-window run would just be repeating itself.
   */
  const several = (current?.tabs?.length ?? 0) > 1;
  const windowTitle = several && tab?.title && tab.title !== label ? plain(tab.title) : null;

  return (
    <>
      <span className="topbar-sep">›</span>
      <span className="topbar-crumb" title={label}>
        {label}
      </span>
      {windowTitle && <span className="topbar-detail">{windowTitle}</span>}
    </>
  );
}
