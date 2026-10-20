/**
 * Single WebSocket to the relay's /ws/console endpoint. Incoming messages are
 * dispatched straight into the zustand stores; outgoing requests get ids so
 * replies can be matched to the pending promise.
 */
import type { ConsoleToServer, ServerToConsole, AgentReply, SerializedValue, PropertyPreview, ScreenEvent, ScreenInput, ScreenSegment, ElementStyles, SourceEntry, SourceText, ProbeArrival } from '@bxconsole/protocol';
import { WS_PATH } from '@bxconsole/protocol';
import { useSessionsStore } from '../state/sessions';
import { useProjectsStore } from '../state/projects';
import { activeTabOf } from '../state/active-tab';
import { dropDomModel } from '../state/dom-model';
import { sessionData, dropSessionData } from '../state/session-data';
import { useElementsSelection } from '../state/elements-selection';

let ws: WebSocket | null = null;
let attempt = 0;
let everConnected = false;
/** messages sent before the socket opened (first page load) */
let outbox: ConsoleToServer[] = [];
const subscribed = new Set<string>();
const pending = new Map<string, (reply: AgentReply) => void>();
let nextId = 1;
/**
 * Replies are routed by id and the relay keeps one map for every console, so
 * two consoles whose counters both start at 1 would answer each other's
 * requests. This prefix makes a page's ids its own.
 */
const idPrefix = Math.random().toString(36).slice(2, 8);
const newId = (kind: string): string => `${kind}${idPrefix}-${nextId++}`;

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}${WS_PATH.console}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    attempt = 0;
    useSessionsStore.getState().setConnection(true);
    const queued = outbox;
    outbox = [];
    if (everConnected) {
      // Reconnect after a relay restart: re-subscribe without replay, we still hold the buffers.
      const queuedSubs = new Set(queued.filter((m) => m.type === 'session.subscribe').map((m) => (m as { sessionId: string }).sessionId));
      for (const id of subscribed) if (!queuedSubs.has(id)) send({ type: 'session.subscribe', sessionId: id, replay: false });
      for (const id of subscribed) send({ type: 'files.list', sessionId: id });
      for (const id of screenListeners.keys()) send({ type: 'screen.subscribe', sessionId: id });
    }
    everConnected = true;
    // First connect: deliver what the UI asked for while we were connecting (subscribe with replay etc.).
    for (const m of queued) send(m);
  });

  ws.addEventListener('message', (ev) => {
    let msg: ServerToConsole;
    try {
      msg = JSON.parse(String(ev.data)) as ServerToConsole;
    } catch {
      return;
    }
    dispatch(msg);
  });

  ws.addEventListener('close', () => {
    ws = null;
    useSessionsStore.getState().setConnection(false);
    const delay = Math.min(10000, 500 * 2 ** attempt++);
    setTimeout(connect, delay);
  });
}

/** Commands that run inside a page, so they need to name which window. */
const TAB_SCOPED = new Set<string>([
  'eval.request',
  'object.getProperties',
  'completions.request',
  'object.invokeGetter',
  'object.storeGlobal',
  'object.toJSON',
  'node.locate',
  'node.scrollIntoView',
  'dom.setAttribute',
  'dom.setText',
  'dom.removeNode',
  'dom.scrollIntoView',
  'dom.getStyles',
  'dom.storeGlobal',
  'sources.list',
  'sources.get',
  'screen.subscribe',
  'screen.unsubscribe',
  'screen.refresh',
  'screen.input',
  // Replay follows the window the strip points at, like every other panel.
  'screen.replay',
]);

export function send(msg: ConsoleToServer): void {
  const out = stampTab(msg);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(out));
    return;
  }
  if (outbox.length < 100) outbox.push(out);
}

/** Address a page command to the window the console is pointed at. */
function stampTab(msg: ConsoleToServer): ConsoleToServer {
  if (!TAB_SCOPED.has(msg.type)) return msg;
  const m = msg as ConsoleToServer & { sessionId?: string; tabId?: string };
  if (!m.sessionId || m.tabId) return msg;
  const tabId = activeTabOf(m.sessionId);
  return tabId ? ({ ...m, tabId } as ConsoleToServer) : msg;
}

export function subscribeSession(sessionId: string): void {
  if (subscribed.has(sessionId)) return;
  subscribed.add(sessionId);
  const st = sessionData(sessionId).getState();
  st.reset();
  send({ type: 'session.subscribe', sessionId, replay: true });
  // What the relay is holding, so the Network tab can say for every row at
  // once whether its body can still be read.
  send({ type: 'files.list', sessionId });
  // The agent may hold a different block list / cache flag than this UI remembers: make them agree.
  sendNetworkConfigure(sessionId, { blocked: st.blockedPatterns, disableCache: st.disableCache });
}

/** Permanent: removes sessions/session-{id}/ from disk. */
export function forgetSession(sessionId: string): void {
  subscribed.delete(sessionId);
  send({ type: 'session.forget', sessionId });
}

/** Reversible: the recording stays, the row moves to the Trash view. */
export function trashSession(sessionId: string): void {
  send({ type: 'session.trash', sessionId });
}

export function restoreSession(sessionId: string): void {
  send({ type: 'session.restore', sessionId });
}

// Screen events bypass the stores: they are large and frequent, and only the
// mounted ScreenPanel cares. It registers a listener and applies ops directly.
type ScreenListener = (event: ScreenEvent) => void;
const screenListeners = new Map<string, Set<ScreenListener>>();

export function subscribeScreen(sessionId: string, listener: ScreenListener): () => void {
  let set = screenListeners.get(sessionId);
  if (!set) {
    set = new Set();
    screenListeners.set(sessionId, set);
  }
  set.add(listener);
  send({ type: 'screen.subscribe', sessionId });
  return () => {
    set!.delete(listener);
    if (set!.size === 0) {
      screenListeners.delete(sessionId);
      send({ type: 'screen.unsubscribe', sessionId });
    }
  };
}

export function refreshScreen(sessionId: string): void {
  send({ type: 'screen.refresh', sessionId });
}

export function sendScreenInput(sessionId: string, input: ScreenInput): void {
  send({ type: 'screen.input', sessionId, input });
}

// Screen replay (History DOM time travel) is request/reply like the agent
// requests above, but answered by the relay from disk, so it works offline.
const screenReplayPending = new Map<string, (segment: ScreenSegment | null) => void>();
const REPLAY_TIMEOUT_MS = 15000;

/**
 * The recorded screen around `ts`. `seek` returns the keyframe at or before it
 * plus the ops after; `continue` returns the ops after `ts` for playback that
 * is already running. null on timeout (no relay).
 */
export function requestScreenSegment(sessionId: string, ts: number, mode: 'seek' | 'continue'): Promise<ScreenSegment | null> {
  const requestId = newId('s');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      screenReplayPending.delete(requestId);
      resolve(null);
    }, REPLAY_TIMEOUT_MS);
    screenReplayPending.set(requestId, (segment) => {
      clearTimeout(timer);
      resolve(segment);
    });
    send({ type: 'screen.replay', sessionId, requestId, ts, mode });
  });
}

export function sendNetworkConfigure(sessionId: string, patch: { blocked?: string[]; disableCache?: boolean }): void {
  send({ type: 'network.configure', sessionId, ...patch });
}

const REPLY_TIMEOUT_MS = 5000;

export function evaluate(sessionId: string, expression: string): Promise<AgentReply & { type: 'eval.result' }> {
  const commandId = newId('c');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(commandId);
      resolve({
        type: 'eval.result',
        commandId,
        exception: { t: 'error', name: 'Error', message: 'Session not connected (no reply from agent)' },
        durationMs: REPLY_TIMEOUT_MS,
      });
    }, REPLY_TIMEOUT_MS);
    pending.set(commandId, (reply) => {
      clearTimeout(timer);
      if (reply.type === 'eval.result') resolve(reply);
    });
    // `$0` = the Elements selection of this session, like DevTools.
    const sel = useElementsSelection.getState();
    const context = sel.sessionId === sessionId && sel.id !== null ? { selectedNodeId: sel.id } : undefined;
    send({ type: 'eval.request', sessionId, commandId, expression, ...(context ? { context } : {}) });
  });
}

export function getProperties(sessionId: string, objectId: string): Promise<PropertyPreview[] | null> {
  const requestId = newId('p');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, REPLY_TIMEOUT_MS);
    pending.set(requestId, (reply) => {
      clearTimeout(timer);
      if (reply.type === 'object.properties') resolve(reply.properties);
    });
    send({ type: 'object.getProperties', sessionId, requestId, objectId });
  });
}

/** Generic request/reply to the agent via the relay, matched by requestId. */
function request<T extends AgentReply['type']>(
  sessionId: string,
  msg: { type: ConsoleToServer['type'] } & Record<string, unknown>,
  replyType: T,
  timeoutMs = 5000,
): Promise<Extract<AgentReply, { type: T }> | null> {
  const requestId = newId('q');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
    pending.set(requestId, (reply) => {
      clearTimeout(timer);
      resolve(reply.type === replyType ? (reply as Extract<AgentReply, { type: T }>) : null);
    });
    send({ ...msg, sessionId, requestId } as ConsoleToServer);
  });
}

export async function invokeGetter(sessionId: string, objectId: string, name: string): Promise<SerializedValue | null> {
  const r = await request(sessionId, { type: 'object.invokeGetter', objectId, name }, 'object.property');
  return r?.value ?? null;
}

export async function storeAsGlobal(sessionId: string, objectId: string): Promise<string | null> {
  const r = await request(sessionId, { type: 'object.storeGlobal', objectId }, 'object.stored');
  return r?.name ?? null;
}

export async function objectJson(sessionId: string, objectId: string): Promise<string | null> {
  const r = await request(sessionId, { type: 'object.toJSON', objectId }, 'object.json');
  return r?.text ?? null;
}

export async function locateNode(sessionId: string, objectId: string): Promise<number | null> {
  const r = await request(sessionId, { type: 'node.locate', objectId }, 'node.located', 1500);
  return r?.screenId ?? null;
}

export function scrollNodeIntoView(sessionId: string, objectId: string): void {
  send({ type: 'node.scrollIntoView', sessionId, objectId });
}

// ---- Elements tab
export function domSetAttribute(sessionId: string, id: number, name: string, value: string | null): void {
  send({ type: 'dom.setAttribute', sessionId, id, name, value });
}
export function domSetText(sessionId: string, id: number, text: string): void {
  send({ type: 'dom.setText', sessionId, id, text });
}
export function domRemoveNode(sessionId: string, id: number): void {
  send({ type: 'dom.removeNode', sessionId, id });
}
export function domScrollIntoView(sessionId: string, id: number): void {
  send({ type: 'dom.scrollIntoView', sessionId, id });
}
// ---- Sources tab
export async function sourcesList(sessionId: string): Promise<SourceEntry[]> {
  const r = await request(sessionId, { type: 'sources.list' }, 'sources.list');
  return r?.sources ?? [];
}
export async function sourceText(sessionId: string, url: string): Promise<SourceText | null> {
  const r = await request(sessionId, { type: 'sources.get', url }, 'sources.text', 15000);
  return r?.source ?? null;
}

export async function domStoreGlobal(sessionId: string, id: number): Promise<string | null> {
  const r = await request(sessionId, { type: 'dom.storeGlobal', id }, 'object.stored');
  return r?.name ?? null;
}

export async function domGetStyles(sessionId: string, id: number): Promise<ElementStyles | null> {
  const r = await request(sessionId, { type: 'dom.getStyles', id }, 'dom.styles');
  return r?.styles ?? null;
}

const completionCache = new Map<string, { at: number; names: string[] }>();
const COMPLETION_TTL_MS = 3000;

/** Property names for `expression` in the session's page (global scope when empty), cached briefly per expression. */
export function completions(sessionId: string, expression: string): Promise<string[]> {
  const key = `${sessionId}\n${activeTabOf(sessionId) ?? ''}\n${expression}`;
  const cached = completionCache.get(key);
  if (cached && Date.now() - cached.at < COMPLETION_TTL_MS) return Promise.resolve(cached.names);
  const requestId = newId('a');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve([]);
    }, 2000);
    pending.set(requestId, (reply) => {
      clearTimeout(timer);
      if (reply.type !== 'completions.result') return resolve([]);
      completionCache.set(key, { at: Date.now(), names: reply.names });
      resolve(reply.names);
    });
    send({ type: 'completions.request', sessionId, requestId, expression });
  });
}

/** Consumers of connectivity probes, by token (see the Webhook tab). */
const pingListeners = new Map<string, Set<(a: ProbeArrival) => void>>();

export function subscribePings(token: string, listener: (a: ProbeArrival) => void): () => void {
  let set = pingListeners.get(token);
  if (!set) {
    set = new Set();
    pingListeners.set(token, set);
  }
  set.add(listener);
  send({ type: 'ping.subscribe', token });
  return () => {
    set!.delete(listener);
    if (set!.size === 0) {
      pingListeners.delete(token);
      send({ type: 'ping.unsubscribe', token });
    }
  };
}

/** A token for one diagnosis run, from the relay. */
export async function newPingToken(): Promise<{ token: string; expiresAt: number } | null> {
  try {
    const res = await fetch('/ping/new', { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as { token: string; expiresAt: number };
  } catch {
    return null;
  }
}

/**
 * Whether the relay still honours this token.
 *
 * Worth asking before listening: a lapsed token fails in the one way a
 * diagnostic tool must not — the probe gets a 200, so the page looks fine and
 * the tab sits empty. A relay that cannot be reached answers "live", because
 * the token is not what is wrong in that case.
 */
export async function pingTokenLive(token: string): Promise<boolean> {
  try {
    const res = await fetch(`/ping/check/${encodeURIComponent(token)}`);
    if (!res.ok) return true;
    return ((await res.json()) as { live: boolean }).live;
  } catch {
    return true;
  }
}

function dispatch(msg: ServerToConsole): void {
  const sessions = useSessionsStore.getState();
  switch (msg.type) {
    case 'sessions.snapshot':
      sessions.setAll(msg.sessions);
      return;
    case 'projects.snapshot':
      useProjectsStore.getState().setAll(msg.projects, msg.homeProjectId);
      return;
    case 'project.updated':
      useProjectsStore.getState().upsert(msg.project);
      return;
    case 'project.removed':
      useProjectsStore.getState().remove(msg.projectId);
      return;
    case 'session.updated': {
      const was = sessions.byId[msg.session.sessionId]?.connected ?? false;
      sessions.upsert(msg.session);
      // The agent restarted (reload): push back the block list / cache setting it lost.
      if (!was && msg.session.connected && subscribed.has(msg.session.sessionId)) {
        const st = sessionData(msg.session.sessionId).getState();
        if (st.blockedPatterns.length || st.disableCache) {
          sendNetworkConfigure(msg.session.sessionId, { blocked: st.blockedPatterns, disableCache: st.disableCache });
        }
      }
      return;
    }
    case 'session.removed':
      sessions.remove(msg.sessionId);
      subscribed.delete(msg.sessionId);
      // Its buffers and DOM would otherwise be held for the life of the tab.
      dropSessionData(msg.sessionId);
      dropDomModel(msg.sessionId);
      for (const key of [...completionCache.keys()]) if (key.startsWith(`${msg.sessionId}\n`)) completionCache.delete(key);
      return;
    case 'session.event':
      sessionData(msg.sessionId).getState().push(msg.seq, msg.event, msg.tabId);
      return;
    case 'session.history':
      sessionData(msg.sessionId).getState().pushMany(msg.events, msg.done);
      return;
    case 'session.reply': {
      const key = msg.reply.type === 'eval.result' ? msg.reply.commandId : msg.reply.requestId;
      pending.get(key)?.(msg.reply);
      pending.delete(key);
      return;
    }
    case 'screen.event': {
      // A frame still in flight from the window we just switched away from
      // would otherwise land in the mirror we just pointed somewhere else.
      const watching = activeTabOf(msg.sessionId);
      if (msg.tabId && watching && msg.tabId !== watching) return;
      screenListeners.get(msg.sessionId)?.forEach((l) => l(msg.event));
      return;
    }
    case 'files.list':
      sessionData(msg.sessionId).getState().setKeptFiles(msg.files);
      return;
    case 'screen.replaySegment': {
      const resolve = screenReplayPending.get(msg.requestId);
      screenReplayPending.delete(msg.requestId);
      resolve?.(msg.segment);
      return;
    }
    case 'ping.arrived': {
      for (const listen of pingListeners.get(msg.arrival.token) ?? []) listen(msg.arrival);
      return;
    }

    case 'error':
      console.debug('[bxconsole relay]', msg.message);
      return;
  }
}

export type { SerializedValue };
