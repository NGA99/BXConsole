/** Top-bar dropdown to switch the session the whole window is looking at. */
import { useEffect, useRef, useState } from 'react';
import { useSessionList } from '../state/sessions';
import { useActiveTab } from '../state/active-tab';
import { navigate, type PanelId } from './router';

export function SessionPicker({ sessionId, panel }: { sessionId: string; panel: PanelId }) {
  const sessions = useSessionList();
  const current = sessions.find((s) => s.sessionId === sessionId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const label = current ? current.name ?? current.title ?? current.sessionId : `session-${sessionId}`;
  // With the window tabs above, this line reads as the address bar: show the selected window.
  const activeTab = useActiveTab(sessionId);
  const tab = current?.tabs?.find((t) => t.tabId === activeTab);
  const shownUrl = tab?.url ?? current?.url;
  const live = tab ? tab.connected : current?.connected;
  /*
   * The selected window's own title, spelled out here because its tab cannot.
   *
   * A tab is 180px and a title is whatever the page calls itself, so
   * "쇼핑몰 — 주문 확인 페이지" arrives as "쇼핑몰 — 주문 확…" and there was
   * nowhere to read the rest short of hovering. This line is already the
   * address bar for the selected window; the title belongs on it for the same
   * reason the url does.
   *
   * Only when there is a strip to have truncated it, and only when it says
   * something the session's own name does not — a one-window run would just
   * be repeating itself.
   */
  const several = (current?.tabs?.length ?? 0) > 1;
  const windowTitle = several && tab?.title && tab.title !== label ? tab.title : null;

  return (
    <div className="session-picker" ref={ref}>
      <button className="session-picker-button" onClick={() => setOpen((o) => !o)} title={shownUrl}>
        <span className={`dot ${live ? 'on' : 'off'}`} />
        <span className="session-picker-name">{label}</span>
        {windowTitle && <span className="session-picker-window">{windowTitle}</span>}
        {shownUrl && <span className="session-picker-url mono">{shortUrl(shownUrl)}</span>}
        <span className="session-picker-caret">▾</span>
      </button>
      {open && (
        <div className="session-picker-popup">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className={`session-picker-item${s.sessionId === sessionId ? ' current' : ''}`}
              onClick={() => {
                setOpen(false);
                navigate({ panel: panel === 'sessions' ? 'console' : panel, sessionId: s.sessionId });
              }}
            >
              <span className={`dot ${s.connected ? 'on' : 'off'}`} />
              <span className="session-picker-name">{s.name ?? s.title ?? s.sessionId}</span>
              <span className="session-picker-url mono">{shortUrl(s.url)}</span>
            </button>
          ))}
          {sessions.length === 0 && <div className="session-picker-empty">No sessions</div>}
        </div>
      )}
    </div>
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
