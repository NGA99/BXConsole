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
import { useActiveTab, setActiveTab } from '../state/active-tab';
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
  const tabs = useSessionsStore((s) => s.byId[sessionId]?.tabs) ?? [];
  const active = useActiveTab(sessionId);
  const depth = useMemo(() => depths(tabs), [tabs]);

  // Pick a window when there is none, and leave a window the user chose alone
  // even after it closes: its recorded output is still worth reading. Only a
  // selection that no longer exists in the list gets replaced.
  const known = tabs.some((t) => t.tabId === active);
  useEffect(() => {
    if (tabs.length === 0 || known) return;
    const pick = tabs.filter((t) => t.connected).pop() ?? tabs[tabs.length - 1]!;
    setActiveTab(sessionId, pick.tabId);
  }, [tabs, known, sessionId]);

  // One window is the ordinary case; a strip would just take up room.
  if (tabs.length < 2) return null;

  return (
    <div className="tabstrip" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.tabId}
          role="tab"
          aria-selected={t.tabId === active}
          className={`tabstrip-tab${t.tabId === active ? ' active' : ''}${t.connected ? '' : ' gone'}`}
          style={{ paddingLeft: 8 + (depth.get(t.tabId) ?? 0) * 10 }}
          title={`${t.title || t.url}\n${t.url}${t.connected ? '' : '\n(closed)'}`}
          onClick={() => setActiveTab(sessionId, t.tabId)}
        >
          <span className={`tabstrip-dot${t.connected ? ' on' : ''}`} />
          <span className="tabstrip-label">{t.title || nameOf(t.url)}</span>
        </button>
      ))}
    </div>
  );
}

function nameOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname.split('/').filter(Boolean).pop() || u.host) + u.search;
  } catch {
    return url;
  }
}
