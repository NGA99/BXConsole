/**
 * The browser the run is in, drawn as one.
 *
 * Under the console's own tab row sits a block that reads as a browser: the
 * windows as tabs, and below them the address of the one selected. That is
 * what these things are — the tabs are windows of somebody else's browser and
 * the address is the page the agent is on — and saying so in the shape people
 * already know costs less explaining than any label would.
 *
 * The selected tab is the same white as the bar under it, so the two read as
 * one surface and the rest as somewhere else. A browser separates the open tab
 * from the others that way rather than by a shade, and it is the whole reason
 * the block holds together instead of looking like two more toolbars.
 *
 * There are no back and forward buttons. A browser has them because it can go
 * back; this is a recording of where the page went, and the way to move
 * through that is the History panel, which has the times and the events the
 * two arrows could not show. Drawing them to complete the picture would have
 * been two controls that do nothing.
 */
import { useSessionList } from '../state/sessions';
import { useActiveTab } from '../state/active-tab';
import { useScreenReplay } from '../state/screen-replay';
import { refreshScreen } from '../transport/client';
import { plain } from '../devtools-ui/plain-text';
import { address } from './address';
import { TabStrip } from './TabStrip';
import './BrowserChrome.css';

export function BrowserChrome({ sessionId }: { sessionId: string }) {
  const sessions = useSessionList();
  const current = sessions.find((s) => s.sessionId === sessionId);
  const activeTab = useActiveTab(sessionId);
  const tab = current?.tabs?.find((t) => t.tabId === activeTab);

  // The selected window's address, falling back to the run's own for a
  // session whose windows have not arrived yet.
  const url = tab?.url ?? current?.url;
  const live = tab ? tab.connected : (current?.connected ?? false);
  /*
   * A fresh snapshot is of the page as it is now, so it means nothing while
   * the Screen is showing a recorded frame — the mirror drops live batches
   * during replay. The playhead is published by the Screen panel, and is null
   * whenever it is live, which is also true when the panel is folded away.
   */
  const replaying = useScreenReplay((s) => s.playhead?.sessionId === sessionId);

  const shown = url ? address(url) : null;
  const windows = current?.tabs?.length ?? 0;

  return (
    <div className="chrome">
      {/* No row at all for a run with no windows yet, rather than an empty
          band: the strip itself draws nothing, and a 29px gap above the
          address would read as a tab that failed to render. */}
      {windows > 0 && (
        <div className="chrome-tabs">
          <TabStrip sessionId={sessionId} />
        </div>
      )}
      <div className="chrome-bar">
        <button
          className="chrome-reload"
          title={
            replaying
              ? 'Not while replaying: the Screen is showing a recorded frame, not the page as it is now'
              : live
                ? 'Ask the page for a fresh snapshot'
                : 'The window is gone, so there is nothing left to ask'
          }
          disabled={replaying || !live}
          onClick={() => refreshScreen(sessionId)}
        >
          ⟳
        </button>
        <span className="chrome-pill">
          {/*
            * Where a browser puts the lock. It says whether the agent in this
            * window is still connected, which is the one thing about the
            * address that can change under you.
            */}
          <span className={`dot ${live ? 'on' : 'off'}`} title={live ? 'This window is connected' : 'This window is gone'} />
          {shown ? (
            <span className="chrome-url mono" title={plain(url!)}>
              <span className="chrome-host">{plain(shown.head)}</span>
              <span className="chrome-path">{plain(shown.tail)}</span>
            </span>
          ) : (
            <span className="chrome-url empty">no address recorded</span>
          )}
        </span>
      </div>
    </div>
  );
}
