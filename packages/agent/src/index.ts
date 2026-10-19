/**
 * bxconsole agent — loaded into the target page (A) via a single script tag:
 *
 *   <script src="http://localhost:7331/agent.js" data-name="my-app"></script>
 *
 * Boot order matters: hooks must be installed before the page runs its own
 * code, so this file does nothing async before patching globals. Events that
 * fire before the socket is open are queued in the transport.
 */
import { readConfig, type AgentConfig } from './config';
import { getHandle, setHandle, setMark } from './mark';
import { getOrCreateSession, getOrCreateTab, buildHello, adoptTabId, type LocalSession } from './session';
import { Transport } from './transport';
import { createCommandHandler } from './commands';
import { installConsoleHook } from './hooks/console';
import { installErrorHook } from './hooks/errors';
import { installNetworkHook } from './hooks/network';
import { installWebSocketHook } from './hooks/websocket';
import { installResourceHook } from './hooks/resources';
import { installPageHook } from './hooks/page';
import { hostInIframe } from './hooks/frame';
import { installHistoryHook, mark } from './hooks/history';
import { adoptOpeners, adoptChildren, askOpenerToWatch } from './hooks/adopt';
import { setIdPrefix } from './ids';
import { startScreen, setScreenAlwaysOn } from './hooks/screen';


(function boot() {
  if (getHandle(window)) return; // loaded twice

  const config = readConfig();
  // Before anything is written to the page: every trace is named from this.
  setMark(config.mark);
  const session = getOrCreateSession(config);

  /*
   * Hosting (the default): this window becomes scaffolding around a frame
   * holding the app, and nothing else is installed here. The agent that
   * matters is the one it puts inside the frame, and puts back after every
   * navigation.
   *
   * A page that refuses to be framed cannot be hosted, and there is no way to
   * know that without trying. So hosting hands the window back when the frame
   * turns out to be blocked, and the run carries on here instead — one that
   * ends at the first navigation, which is still a great deal better than the
   * blank page this used to leave behind.
   */
  if (hostInIframe(config, session.sessionId, () => install(config, session))) return;
  install(config, session);
})();

function install(config: AgentConfig, session: LocalSession): void {
  if (getHandle(window)) return; // the frame handed back after we had already started
  const tab = getOrCreateTab(config);
  // Request and object ids must not collide with the other windows of this session.
  setIdPrefix(tab.tabId);
  const transport = new Transport(config.serverUrl, () => buildHello(session, tab, config));

  transport.onMessage(createCommandHandler(transport));
  // The relay settles window identity: if it hands back a different id than we
  // asked for, two live windows were claiming ours, and this one is the new one.
  transport.onMessage((msg) => {
    if (msg.type !== 'session.ack' || !msg.tabId || msg.tabId === tab.tabId) return;
    adoptTabId(tab, msg.tabId);
    setIdPrefix(msg.tabId);
    const handle = getHandle(window);
    if (handle) handle.tabId = msg.tabId;
  });

  installConsoleHook(transport, config);
  installErrorHook(transport);
  installNetworkHook(transport, config);
  installWebSocketHook(transport, config);
  // Before the resource hook, and that order is load-bearing. page.navigated
  // is what tells the console a document started, and the console clears that
  // window's log on it. The resource hook's first act is to flush whatever
  // Resource Timing already holds — which in a window the agent was adopted
  // into is the whole page. Reported first, those rows were wiped by the very
  // event announcing the document they came from.
  installPageHook(transport);
  installResourceHook(transport);
  installHistoryHook(transport);

  // data-screen="record": stream the DOM from the first tick so the History tab
  // can replay any moment, not only what someone watched live.
  if (config.screen === 'record') {
    setScreenAlwaysOn(true);
    startScreen(transport);
  }

  transport.connect();

  // Publish before adopting: the windows we reach read this to tell whether a
  // tab id they inherited is really theirs.
  setHandle(window, { sessionId: session.sessionId, tabId: tab.tabId, transport, mark: (name: string, data?: unknown) => mark(transport, name, data) });

  // Bring the rest of the run in: the windows that opened this one, and any it
  // opens from here. `data-adopt="0"` keeps the agent to this window alone.
  if (config.adopt) {
    adoptChildren(config, session.sessionId);
    adoptOpeners(config, session.sessionId);
    // The window above may have existed before us, so it is not watching this
    // one yet; without asking, a navigation here would end the agent for good.
    askOpenerToWatch();
  }
}
