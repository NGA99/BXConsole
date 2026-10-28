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
 */
import { useSessionList } from '../state/sessions';
import { useActiveTab } from '../state/active-tab';
import { plain } from '../devtools-ui/plain-text';

export function SessionLabel({ sessionId }: { sessionId: string }) {
  const sessions = useSessionList();
  const current = sessions.find((s) => s.sessionId === sessionId);

  const label = plain(current ? current.name ?? current.title ?? current.sessionId : `session-${sessionId}`);
  // The windows are tabs in the strip below; this names the one selected.
  const activeTab = useActiveTab(sessionId);
  const tab = current?.tabs?.find((t) => t.tabId === activeTab);
  const shownUrl = tab?.url ?? current?.url;
  const live = tab ? tab.connected : current?.connected;
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
        <span className={`dot ${live ? 'on' : 'off'}`} />
        {label}
      </span>
      {windowTitle && <span className="topbar-detail">{windowTitle}</span>}
      {/* No chevron before the address: it is what the run is on, not another
          level of where you are, and it gives way first when the row is tight. */}
      {shownUrl && (
        <span className="topbar-url mono" title={plain(shownUrl)}>
          {plain(shortUrl(shownUrl))}
        </span>
      )}
    </>
  );
}

/**
 * The window's address, as this line is meant to read like one.
 *
 * It used to stop at the path, which threw away the query — and the query is
 * often the only thing telling two windows of a run apart. Three tabs all
 * titled "Example Domain" on `/?1`, `/?2` and `/?3` showed as the same host
 * three times, which is worse than showing nothing.
 *
 * The scheme is dropped on https, where it says nothing, and kept on anything
 * else: a run on plain http is a fact about the engagement.
 */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const scheme = u.protocol === 'https:' ? '' : `${u.protocol}//`;
    // A bare "/" is noise, but not once there is a query hanging off it.
    const path = u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname;
    return scheme + u.host + path + u.search + u.hash;
  } catch {
    return url;
  }
}
