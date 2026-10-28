/**
 * The windows of one session, shown as tabs.
 *
 * A session is a debugging run: when the page opens another window it keeps
 * the session id, so the run can hold several windows. This strip picks which
 * one Console, Network, Screen and the prompt are pointed at. History ignores
 * the selection and shows the whole run.
 *
 * Tabs a window opened are indented under their opener, so an A -> B -> C
 * flow reads as a tree.
 */
import { useEffect, useMemo } from 'react';
import type { SessionTab } from '@bxconsole/protocol';
import { useSessionsStore } from '../state/sessions';
import { sessionData } from '../state/session-data';
import { useActiveTab, setActiveTab } from '../state/active-tab';
import { compact, describe as describeTab } from './tab-label';
import { useSelectedInView } from '../devtools-ui/selected-in-view';
import { plain } from '../devtools-ui/plain-text';
import './TabStrip.css';

/** Depth of each tab in the opener tree, capped so a long chain stays readable. */
function depths(tabs: SessionTab[]): Map<string, number> {
  const byId = new Map(tabs.map((t) => [t.tabId, t]));
  const out = new Map<string, number>();
  for (const t of tabs) {
    let d = 0;
    let cur = t;
    const seen = new Set<string>([t.tabId]);
    while (cur.openedBy && byId.has(cur.openedBy) && !seen.has(cur.openedBy) && d < 4) {
      seen.add(cur.openedBy);
      cur = byId.get(cur.openedBy)!;
      d++;
    }
    out.set(t.tabId, d);
  }
  return out;
}

export function TabStrip({ sessionId }: { sessionId: string }) {
  const recorded = useSessionsStore((s) => s.byId[sessionId]?.tabs) ?? [];
  /*
   * Live windows first, each group keeping the order the run made.
   *
   * A long run leaves closed windows behind, and they pile up to the left of
   * the ones still open — which are the only ones a command can be sent to.
   * The opener indentation still marks who opened whom; it just no longer
   * reads as one contiguous tree once a parent has closed and its child has
   * not. A window that can still be driven being easy to reach is worth more
   * than the shape.
   */
  const tabs = useMemo(() => [...recorded.filter((t) => t.connected), ...recorded.filter((t) => !t.connected)], [recorded]);
  /*
   * How much each window has done, counted from the events as they arrive.
   *
   * A run's windows look alike in a strip — the same site, often the same
   * title — and nothing in it said which one is worth opening. One of this
   * session's naver windows had produced 1,902 events and another 126, and
   * they read identically. The number is every event the window produced,
   * deliberately: weighting them would mean inventing a formula nobody can
   * read off the tab.
   *
   * It is not a sort key. The strip's order is the run's own — live windows
   * first, then the order they were made — and an order that rearranged
   * itself as traffic arrived would be unusable.
   */
  const counts = sessionData(sessionId)((s) => s.eventsByTab);
  const active = useActiveTab(sessionId);
  const depth = useMemo(() => depths(tabs), [tabs]);
  // The host the run started on, so only the hops away from it are spelled out.
  const baseHost = hostOf(tabs[0]?.url ?? '');

  // Pick a window when there is none, and leave a window the user chose alone
  // even after it closes: its recorded output is still worth reading. Only a
  // selection that no longer exists in the list gets replaced.
  const known = tabs.some((t) => t.tabId === active);
  useEffect(() => {
    if (tabs.length === 0 || known) return;
    const pick = tabs.filter((t) => t.connected).pop() ?? tabs[tabs.length - 1]!;
    setActiveTab(sessionId, pick.tabId);
  }, [tabs, known, sessionId]);

  const strip = useSelectedInView(active);

  // One window is the ordinary case; a strip would just take up room.
  /*
   * Shown from the first window, not the second.
   *
   * It used to appear only once a run had two windows, so the chrome gained a
   * row the moment a page opened a popup and everything below it jumped. With
   * `spread` on that happens constantly, and the strip is the control you
   * reach for when it does. One window draws one tab, which costs a row but
   * keeps the session view the same shape throughout the run.
   */
  if (tabs.length === 0) return null;

  return (
    <div className="tabstrip" role="tablist" ref={strip}>
      {tabs.map((t) => (
        <button
          key={t.tabId}
          role="tab"
          aria-selected={t.tabId === active}
          className={`tabstrip-tab${t.tabId === active ? ' active' : ''}${t.connected ? '' : ' gone'}`}
          style={{ paddingLeft: 8 + (depth.get(t.tabId) ?? 0) * 10 }}
          title={describeTab(t, counts[t.tabId] ?? 0)}
          onClick={() => setActiveTab(sessionId, t.tabId)}
        >
          <span className={`tabstrip-dot${t.connected ? ' on' : ''}`} />
          <span className="tabstrip-label">{plain(t.title || hostOf(t.url) || t.url)}</span>
          <span className="tabstrip-where">{whereOf(t.url, baseHost)}</span>
          <span className="tabstrip-count">{compact(counts[t.tabId] ?? 0)}</span>
        </button>
      ))}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Which page this window is on, next to its title.
 *
 * The title alone is what a browser shows, and for one window that is right.
 * A run is not one window: it is several, often on the same app and sometimes
 * on different hosts, and "Dashboard" three times over says nothing about
 * which is which. So the path is always shown, and the host only when it
 * differs from the window the run started in — where a cross-origin hop is
 * the thing worth noticing, and repeating the same host on every tab would
 * bury it.
 */
function whereOf(url: string, baseHost: string): string {
  try {
    const u = new URL(url);
    const path = (u.pathname === '/' ? '' : u.pathname) + u.search;
    if (u.host !== baseHost) return u.host + path;
    return path;
  } catch {
    return url;
  }
}
