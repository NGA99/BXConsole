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

  return (
    <div className="session-picker" ref={ref}>
      <button className="session-picker-button" onClick={() => setOpen((o) => !o)} title={shownUrl}>
        <span className={`dot ${live ? 'on' : 'off'}`} />
        <span className="session-picker-name">{label}</span>
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

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}
