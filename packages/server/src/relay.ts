/**
 * Message routing between agents and consoles.
 *
 *   agent  --event-->  persist to sessions/session-{id}/  --> every subscriber
 *   console --eval-->  the agent for the named window      --> reply back to the asking console
 *
 * A session can hold several windows (the page opened another with
 * window.open, which inherits the session id), so each agent connection
 * carries a tabId. Events are tagged with it and commands are routed by it;
 * the console shows the windows as tabs inside the one session.
 *
 * Session list changes (connect/disconnect/navigate) are broadcast to every
 * console regardless of subscription, since the Sessions tab shows all.
 *
 * Screen events take their own path: they are appended to the session's Screen
 * recording (screen-log.ts) and forwarded only to the consoles watching it.
 * Keyframes for that recording are requested here, so a seek in the past costs
 * one keyframe plus the ops after it.
 */
import type { WebSocket } from 'ws';
import {
  isValidSessionId,
  type AssetData,
  isScreenEvent,
  type ScreenEvent,
  type ScreenCursor,
  type ScreenMutations,
  type ScreenSnapshot,
  type AgentEvent,
  type AgentReply,
  type AgentToServer,
  type ConsoleToServer,
  type ServerToAgent,
  type ServerToConsole,
  type SequencedEvent,
  type SourceEntry,
  type SourceText,
} from '@bxconsole/protocol';
import { agentFor, type SessionEntry, type SessionRegistry } from './registry';
import type { PingBoard } from './ping';
import type { BlobStore } from './blobs';
import type { AssetCollector } from './collect';
import { bodyOf, carriesBody, withBodyRef } from './net-bodies';
import type { SessionStore } from './store';

/** A keyframe is due this long after the last one… */
const KEYFRAME_MS = 30_000;
/** …or after this many ops, whichever comes first (a busy page gets more of them). */
const KEYFRAME_OPS = 2000;
/*
 * Cursor sampling for the recording.
 *
 * The page sends one cursor event per animation frame. Recording all of them
 * costs something like ten megabytes an hour against a fifty megabyte budget
 * that is trimmed from the front — so the pointer would push out the keyframes
 * it exists to annotate. Twelve a second looks continuous to a viewer and
 * costs a tenth of that.
 *
 * A press is never dropped: where the pointer was when a button went down is
 * the one position in the whole trail that has to be exact.
 */
const CURSOR_SAMPLE_MS = 80;
/** Movement smaller than this is not worth a line. */
const CURSOR_MIN_PX = 4;

/** How long an asset request may keep an HTTP response waiting on the page. */
const ASSET_TIMEOUT_MS = 20_000;

/** Where a session's recording stands, so keyframes are asked for at the right moments. */
interface ScreenState {
  lastKeyframeAt: number;
  opsSinceKeyframe: number;
  /** a keyframe has been asked for and not arrived yet */
  awaitingKeyframe: boolean;
  /** the window whose stream is being recorded, so keyframes go back to it */
  tabId: string;
}

export class Relay {
  private readonly consoles = new Set<WebSocket>();
  private readonly screenState = new Map<string, ScreenState>();
  /** which console asked for a given commandId/requestId, so replies route back */
  private readonly pendingReplies = new Map<string, WebSocket>();
  /** the blocking / cache settings in force per session, replayed to windows that join later */
  private readonly networkConfig = new Map<string, { blocked?: string[]; disableCache?: boolean }>();
  /** days a recording is kept, so the console can say so; 0 means forever */
  private retentionDays = 0;
  /** consoles mid-replay, with the live events waiting for it to finish */
  private readonly replaying = new Map<WebSocket, ServerToConsole[]>();
  /** replies the relay itself is waiting for (the asset proxy), not a console */
  private readonly pendingInternal = new Map<string, (reply: AgentReply) => void>();
  private internalSeq = 0;
  /** connectivity-probe tokens each console is watching (see ping.ts) */
  private readonly pingWatchers = new Map<WebSocket, Set<string>>();
  private pingBoard: PingBoard | null = null;
  /** the shared file store, so a url already fetched is not fetched again */
  private blobs: BlobStore | null = null;
  /** which url each in-flight sources.get asked for, so the reply can be stored */
  private readonly sourceAsks = new Map<string, { sessionId: string; url: string }>();
  /** the last cursor position written to each recording, for sampling */
  private readonly lastCursor = new Map<string, { ts: number; x: number; y: number; pressed: boolean }>();
  /** pulls the page's own files in while the page is still there to fetch them */
  private collector: AssetCollector | null = null;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly store: SessionStore,
  ) {
    registry.onChange((entry) => this.broadcast({ type: 'session.updated', session: entry.meta }));
  }

  // ------------------------------------------------------------------ agents

  attachAgent(ws: WebSocket): void {
    let entry: SessionEntry | null = null;
    let tabId = '';

    // Everything below is page-controlled. One bad message used to throw out of
    // an async listener, which Node turns into an unhandled rejection and an
    // exit, taking every session and every console down with it.
    const handle = async (raw: unknown): Promise<void> => {
      const msg = parse<AgentToServer>(raw);
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'session.hello') {
        if (!validHello(msg.hello)) return;
        const joined = await this.registry.upsertFromHello(msg.hello, ws);
        entry = joined.entry;
        // The relay may hand back a different window id than the page asked for
        // (two live windows claiming one id); the ack is how the page learns it.
        tabId = joined.tabId;
        send(ws, { type: 'session.ack', sessionId: entry.meta.sessionId, tabId } satisfies ServerToAgent);
        // A window that joins a session already configured must honour the same
        // blocking and cache settings; nothing else would ever tell it.
        const cfg = this.networkConfig.get(entry.meta.sessionId);
        if (cfg) send(ws, { type: 'network.configure', ...cfg });
        // A reload while someone is watching: resume streaming immediately.
        if (this.watchersOf(entry, tabId) > 0) send(ws, { type: 'screen.start' });
        return;
      }
      if (!entry) return; // events before hello are dropped

      if (isScreenEvent(msg)) {
        if (msg.type === 'screen.mutations' && !Array.isArray(msg.ops)) return;
        this.recordScreen(entry, msg, tabId);
        // A keyframe is for the recording only: every live viewer is already in
        // sync, and reloading their mirror would just make it flash.
        if (msg.type === 'screen.snapshot' && msg.keyframe) return;
        const out: ServerToConsole = { type: 'screen.event', sessionId: entry.meta.sessionId, event: msg, tabId };
        for (const [sub, watched] of entry.screenSubscribers) {
          if (watched === undefined || watched === tabId) send(sub, out);
        }
        return;
      }
      if (isReply(msg)) {
        this.routeReply(entry, msg, tabId);
      } else {
        this.handleAgentEvent(entry, msg, tabId);
      }
    };

    ws.on('message', (raw) => {
      void handle(raw).catch((err) => warn('agent message', err));
    });

    ws.on('close', () => {
      if (!entry) return;
      void this.registry.markTabDisconnected(entry.meta.sessionId, tabId, ws);
      // Only the recording window's departure ends the recording; a popup
      // closing must not punch a hole in the window that is still streaming.
      if (this.screenState.get(entry.meta.sessionId)?.tabId === tabId) {
        this.screenState.delete(entry.meta.sessionId);
        // The next window to stream starts its own trail rather than carrying
        // on from where a cursor in a different document happened to stop.
        this.lastCursor.delete(entry.meta.sessionId);
      }
      // The last window of the run just left: whatever is still queued can no
      // longer be fetched from anywhere, so stop asking.
      if (entry.agents.size === 0) this.collector?.forget(entry.meta.sessionId);
    });
  }

  /**
   * Append a snapshot / op batch to the session's recording and ask for the
   * next keyframe when one is due. Cursor and `stopped` events are live-only.
   */
  private recordScreen(entry: SessionEntry, event: ScreenEvent, tabId: string): void {
    const id = entry.meta.sessionId;
    if (event.type === 'screen.snapshot') {
      // Key order matters: screen-log.ts recognises keyframe lines by their prefix.
      this.store.screen.append(id, { k: 1, ts: event.ts, snapshot: event });
      this.screenState.set(id, { lastKeyframeAt: event.ts, opsSinceKeyframe: 0, awaitingKeyframe: false, tabId });
      return;
    }
    if (event.type === 'screen.cursor') {
      if (event.visible) this.recordCursor(id, event);
      return;
    }
    if (event.type !== 'screen.mutations') return;

    const state = this.screenState.get(id);
    if (!state) {
      // Ops with no keyframe behind them in this process (the relay restarted
      // under a page that keeps recording): anchor the recording first, and
      // drop these, since nothing could replay them.
      this.screenState.set(id, { lastKeyframeAt: event.ts, opsSinceKeyframe: 0, awaitingKeyframe: true, tabId });
      const a = agentFor(entry, tabId);
      if (a) send(a, { type: 'screen.keyframe' });
      return;
    }

    this.store.screen.append(id, { k: 0, ts: event.ts, ops: event.ops });
    state.opsSinceKeyframe += event.ops.length;
    const due = event.ts - state.lastKeyframeAt >= KEYFRAME_MS || state.opsSinceKeyframe >= KEYFRAME_OPS;
    // Back to the window that produced these ops: a keyframe from any other
    // window would anchor this recording to the wrong document, and a window
    // that is not streaming answers nothing, latching the flag forever.
    state.tabId = tabId;
    const streaming = agentFor(entry, tabId);
    if (due && !state.awaitingKeyframe && streaming) {
      state.awaitingKeyframe = true;
      send(streaming, { type: 'screen.keyframe' });
    }
  }

  /** Replay the last recorded frame to a console looking at a session whose agent is gone. */
  private async sendFrozenScreen(entry: SessionEntry, ws: WebSocket): Promise<void> {
    const id = entry.meta.sessionId;
    const bounds = await this.store.screen.bounds(id);
    const frame = bounds
      ? await this.store.screen.segment(id, bounds.end, 'seek')
      : await this.store.readLegacyScreenFrame<{ snapshot: ScreenSnapshot; ops: ScreenMutations[] }>(id).then((f) =>
          f ? { snapshot: f.snapshot, batches: f.ops.map((o) => ({ ts: o.ts, ops: o.ops })) } : null,
        );
    if (!frame?.snapshot) return send(ws, { type: 'error', message: 'session not connected' });
    send(ws, { type: 'screen.event', sessionId: id, event: frame.snapshot });
    for (const b of frame.batches) send(ws, { type: 'screen.event', sessionId: id, event: { type: 'screen.mutations', ts: b.ts, ops: b.ops } });
    send(ws, { type: 'screen.event', sessionId: id, event: { type: 'screen.stopped', ts: Date.now() } });
  }

  /**
   * Synchronous on purpose: fan-out must keep the agent's order (a `page.navigated`
   * that clears the console must never overtake the message logged right after it),
   * so nothing here awaits before sending. Persistence is queued per session.
   */
  private handleAgentEvent(entry: SessionEntry, event: AgentEvent, tabId: string): void {
    const seq = this.registry.nextSeq(entry);
    const out: ServerToConsole = { type: 'session.event', sessionId: entry.meta.sessionId, seq, event, tabId };
    for (const sub of entry.subscribers) {
      const held = this.replaying.get(sub);
      if (held) held.push(out);
      else send(sub, out);
    }

    // The copy that goes to disk may differ from the one just sent: a large
    // body is written to the blob store and the line keeps only its hash.
    // Consoles already have the bytes, so there is nothing to look up live.
    void this.store.appendEvent(entry.meta.sessionId, this.forStorage(entry.meta.sessionId, { seq, event, tabId }));
    if (event.type === 'page.navigated') {
      void this.registry.updateTab(entry.meta.sessionId, tabId, { url: event.url, title: event.title });
    }
    if (event.type === 'page.title') {
      void this.registry.updateTab(entry.meta.sessionId, tabId, { title: event.title });
    }
    // The page just loaded a file. It can hand the bytes over now; after the
    // run ends nothing can. `collect !== false` so a recording from before the
    // option existed still collects.
    if (event.type === 'network.resource' && this.collector && entry.meta.collect !== false) {
      this.collector.offer(entry.meta.sessionId, event.entry.name, tabId);
    }
  }

  /** Sample the pointer into the recording; see CURSOR_SAMPLE_MS for why. */
  private recordCursor(sessionId: string, event: ScreenCursor): void {
    const last = this.lastCursor.get(sessionId);
    const moved = !last || Math.abs(event.x - last.x) >= CURSOR_MIN_PX || Math.abs(event.y - last.y) >= CURSOR_MIN_PX;
    const pressChanged = !last || last.pressed !== event.pressed;
    const due = !last || event.ts - last.ts >= CURSOR_SAMPLE_MS;
    if (!pressChanged && (!moved || !due)) return;

    this.lastCursor.set(sessionId, { ts: event.ts, x: event.x, y: event.y, pressed: event.pressed });
    /*
     * The anchor is kept only while the button is down.
     *
     * It is what places the cursor exactly when the mirror has reflowed to a
     * different width, and it costs 105 bytes against the 71 a bare position
     * takes — measured, not guessed. Carried on every sample that is about
     * two thirds of the trail's size, and continuous movement would spend a
     * sixth of the recording's budget every hour. A press is the one moment
     * where being a few pixels out matters, so that is where it is paid for.
     */
    const keepAnchor = event.pressed && event.anchor;
    this.store.screen.append(sessionId, {
      k: 2,
      ts: event.ts,
      pointer: { x: event.x, y: event.y, pressed: event.pressed, ...(keepAnchor ? { anchor: event.anchor } : {}) },
    });
  }

  private routeReply(entry: SessionEntry, reply: AgentReply, tabId: string): void {
    const key = reply.type === 'eval.result' ? reply.commandId : reply.requestId;
    const internal = this.pendingInternal.get(key);
    if (internal) {
      this.pendingInternal.delete(key);
      internal(reply);
      return;
    }
    // A source the page just handed over is worth keeping: it is the file as
    // this run saw it, and the next deploy will replace the original.
    const asked = this.sourceAsks.get(key);
    if (asked) {
      this.sourceAsks.delete(key);
      if (reply.type === 'sources.text') void this.storeSource(asked.sessionId, asked.url, reply.source);
    }
    const target = this.pendingReplies.get(key);
    this.pendingReplies.delete(key);
    if (target) send(target, { type: 'session.reply', sessionId: entry.meta.sessionId, reply, tabId });
  }

  // ---------------------------------------------------------------- consoles

  attachConsole(ws: WebSocket): void {
    this.consoles.add(ws);
    send(ws, { type: 'sessions.snapshot', sessions: this.registry.all(), retentionDays: this.retentionDays });

    ws.on('message', (raw) => {
      const msg = parse<ConsoleToServer>(raw);
      if (!msg || typeof msg.type !== 'string') return;
      void this.handleConsoleMessage(ws, msg).catch((err) => warn('console message', err));
    });

    ws.on('close', () => {
      this.consoles.delete(ws);
      this.replaying.delete(ws);
      this.pingWatchers.delete(ws);
      for (const [key, target] of this.pendingReplies) if (target === ws) this.pendingReplies.delete(key);
      for (const id of this.registry.all().map((m) => m.sessionId)) {
        const entry = this.registry.get(id);
        if (!entry) continue;
        entry.subscribers.delete(ws);
        this.unsubscribeScreen(entry, ws);
      }
    });
  }

  /**
   * Forward connectivity probes to the consoles watching their token.
   *
   * Probes arrive over plain HTTP from a page that may have no agent and no
   * session at all, which is the whole point: this is how a page that cannot
   * reach us still says something.
   */
  /** Use this store to answer and to remember what the pages hand over. */
  useBlobs(blobs: BlobStore): void {
    this.blobs = blobs;
  }

  /** Fetch the files a page loads as it loads them, for sessions that asked. */
  useCollector(collector: AssetCollector): void {
    this.collector = collector;
  }

  watchPings(board: PingBoard): void {
    this.pingBoard = board;
    board.onArrival((arrival) => {
      for (const [ws, tokens] of this.pingWatchers) {
        if (tokens.has(arrival.token)) send(ws, { type: 'ping.arrived', arrival });
      }
    });
  }

  private async handleConsoleMessage(ws: WebSocket, msg: ConsoleToServer): Promise<void> {
    switch (msg.type) {
      case 'ping.subscribe': {
        let watched = this.pingWatchers.get(ws);
        if (!watched) {
          watched = new Set();
          this.pingWatchers.set(ws, watched);
        }
        watched.add(msg.token);
        // Whatever already landed, so a console opened late is not told nothing happened.
        for (const arrival of this.pingBoard?.since(msg.token) ?? []) send(ws, { type: 'ping.arrived', arrival });
        return;
      }

      case 'ping.unsubscribe':
        this.pingWatchers.get(ws)?.delete(msg.token);
        return;

      case 'sessions.list':
        send(ws, { type: 'sessions.snapshot', sessions: this.registry.all(), retentionDays: this.retentionDays });
        return;

      case 'session.subscribe': {
        const entry = this.registry.get(msg.sessionId);
        if (!entry) return send(ws, { type: 'error', message: `unknown session ${msg.sessionId}` });
        entry.subscribers.add(ws);
        if (!msg.replay) return;
        // Hold live events for this console until its replay has finished.
        // Sent straight through, they would arrive before the history they
        // come after, and the console appends in arrival order: the newest
        // messages would sit above the oldest, with duplicates where an event
        // was written to disk just as it was read back.
        const held: ServerToConsole[] = [];
        this.replaying.set(ws, held);
        try {
          for await (const chunk of this.store.readHistory(msg.sessionId)) {
            send(ws, { type: 'session.history', sessionId: msg.sessionId, events: chunk, done: false });
          }
          send(ws, { type: 'session.history', sessionId: msg.sessionId, events: [], done: true });
        } finally {
          this.replaying.delete(ws);
          for (const m of held) send(ws, m);
        }
        return;
      }

      case 'session.unsubscribe':
        this.registry.get(msg.sessionId)?.subscribers.delete(ws);
        return;

      case 'session.trash':
      case 'session.restore': {
        if (await this.registry.setTrashed(msg.sessionId, msg.type === 'session.trash')) {
          const entry = this.registry.get(msg.sessionId);
          if (entry) this.broadcast({ type: 'session.updated', session: entry.meta });
        }
        return;
      }

      case 'session.forget':
        if (await this.registry.forget(msg.sessionId)) {
          this.networkConfig.delete(msg.sessionId);
          this.screenState.delete(msg.sessionId);
          this.lastCursor.delete(msg.sessionId);
          this.broadcast({ type: 'session.removed', sessionId: msg.sessionId });
        }
        return;

      case 'eval.request': {
        const agent = this.agentFromMessage(msg);
        if (!agent) return send(ws, { type: 'error', message: 'session not connected' });
        this.pendingReplies.set(msg.commandId, ws);
        send(agent, { type: 'eval.request', commandId: msg.commandId, expression: msg.expression, ...(msg.context ? { context: msg.context } : {}) });
        return;
      }

      case 'object.getProperties': {
        const agent = this.agentFromMessage(msg);
        if (!agent) return send(ws, { type: 'error', message: 'session not connected' });
        this.pendingReplies.set(msg.requestId, ws);
        send(agent, { type: 'object.getProperties', requestId: msg.requestId, objectId: msg.objectId });
        return;
      }

      case 'sources.get': {
        /*
         * Answer from what we already hold, if we hold it.
         *
         * The same file is otherwise fetched by the page, again for this tab,
         * and again for the Network body view — each one a real request to
         * the debugged server. It also means a file stays readable after the
         * session goes quiet, where before it simply could not be opened.
         */
        const held = await this.blobs?.lookup(msg.sessionId, msg.url);
        const body = held ? await this.blobs?.read(held.sha) : null;
        const answer = (source: SourceText) =>
          send(ws, {
            type: 'session.reply',
            sessionId: msg.sessionId,
            reply: { type: 'sources.text', requestId: msg.requestId, source },
            tabId: msg.tabId ?? '',
          });
        if (held && body) return answer({ ...toSourceText(msg.url, held.mime, body), fromStore: true });

        const agent = this.agentFromMessage(msg);
        /*
         * Nothing held and nobody to ask. Say so as an answer rather than as
         * a protocol error: the console was waiting for a `sources.text` and
         * got something it does not route, so it sat on the request until its
         * own timeout — fifteen seconds to be told nothing, on a run that was
         * never going to answer.
         */
        if (!agent) {
          return answer({
            url: msg.url,
            text: null,
            error: 'this file was not kept while the run was live, and the run has ended, so there is nowhere left to read it from',
          });
        }
        this.pendingReplies.set(msg.requestId, ws);
        this.sourceAsks.set(msg.requestId, { sessionId: msg.sessionId, url: msg.url });
        const { sessionId: _sid, tabId: _tid, ...rest } = msg;
        send(agent, rest as ServerToAgent);
        return;
      }

      /*
       * What the relay is holding for this session.
       *
       * The Network tab asks once, on subscribe, because "can this body still
       * be read" is a question about every row at once and asking per row
       * only ever answers for the row already open.
       */
      case 'files.list': {
        const files = this.blobs ? await this.blobs.list(msg.sessionId) : [];
        return send(ws, {
          type: 'files.list',
          sessionId: msg.sessionId,
          files: files.map(({ url, bytes, mime }) => ({ url, bytes, mime })),
        });
      }

      case 'sources.list': {
        const agent = this.agentFromMessage(msg);
        if (agent) {
          this.pendingReplies.set(msg.requestId, ws);
          const { sessionId: _s, tabId: _t, ...rest } = msg;
          send(agent, rest as ServerToAgent);
          return;
        }
        /*
         * Offline, answer from what the run left behind. Without this the
         * files are stored and unreachable: the list is the only way into
         * them, and asking the page for it is exactly what cannot be done
         * once the page is gone.
         */
        const held = (await this.blobs?.list(msg.sessionId)) ?? [];
        const sources = held.filter((f) => f.kind === 'keep').map(toSourceEntry);
        if (!sources.length) return send(ws, { type: 'error', message: 'session not connected' });
        send(ws, {
          type: 'session.reply',
          sessionId: msg.sessionId,
          reply: { type: 'sources.list', requestId: msg.requestId, sources },
          tabId: msg.tabId ?? '',
        });
        return;
      }

      case 'completions.request':
      case 'object.invokeGetter':
      case 'object.storeGlobal':
      case 'object.toJSON':
      case 'node.locate':
      case 'dom.getStyles':
      case 'dom.storeGlobal': {
        const agent = this.agentFromMessage(msg);
        if (!agent) return send(ws, { type: 'error', message: 'session not connected' });
        this.pendingReplies.set(msg.requestId, ws);
        const { sessionId: _sid, tabId: _tid, ...rest } = msg;
        send(agent, rest as ServerToAgent);
        return;
      }

      case 'node.scrollIntoView':
      case 'dom.setAttribute':
      case 'dom.setText':
      case 'dom.removeNode':
      case 'dom.scrollIntoView': {
        const agent = this.agentFromMessage(msg);
        if (!agent) return;
        const { sessionId: _sid, tabId: _tid, ...rest } = msg;
        send(agent, rest as ServerToAgent);
        return;
      }

      case 'network.configure': {
        // Blocking and cache settings belong to the whole run, so every window gets them.
        const entry = this.registry.get(msg.sessionId);
        if (!entry || entry.agents.size === 0) return send(ws, { type: 'error', message: 'session not connected' });
        const cfg = { ...(msg.blocked ? { blocked: msg.blocked } : {}), ...(msg.disableCache !== undefined ? { disableCache: msg.disableCache } : {}) };
        this.networkConfig.set(msg.sessionId, { ...this.networkConfig.get(msg.sessionId), ...cfg });
        const cmd: ServerToAgent = { type: 'network.configure', ...cfg };
        for (const a of entry.agents.values()) send(a, cmd);
        return;
      }

      case 'screen.subscribe':
      case 'screen.refresh': {
        const entry = this.registry.get(msg.sessionId);
        if (!entry) return send(ws, { type: 'error', message: `unknown session ${msg.sessionId}` });
        // Stay registered even with no agent: the window may come back, and the
        // hello path starts streaming only for windows someone is watching.
        entry.screenSubscribers.set(ws, msg.tabId);
        const agent = agentFor(entry, msg.tabId);
        if (!agent) return void this.sendFrozenScreen(entry, ws);
        // Every (re)start yields a fresh snapshot, which is what a new subscriber
        // needs; windows nobody is left watching stop.
        send(agent, { type: 'screen.start' });
        this.stopUnwatched(entry);
        return;
      }

      case 'screen.unsubscribe': {
        const entry = this.registry.get(msg.sessionId);
        if (entry) this.unsubscribeScreen(entry, ws);
        return;
      }

      case 'screen.input': {
        const entry = this.registry.get(msg.sessionId);
        if (!entry || !entry.screenSubscribers.has(ws)) return;
        const agent = agentFor(entry, msg.tabId ?? entry.screenSubscribers.get(ws));
        if (agent) send(agent, { type: 'screen.input', input: msg.input });
        return;
      }

      // DOM time travel. Served from disk, so an offline session replays like a live one.
      case 'screen.replay': {
        const segment = await this.store.screen.segment(msg.sessionId, msg.ts, msg.mode);
        send(ws, { type: 'screen.replaySegment', sessionId: msg.sessionId, requestId: msg.requestId, segment });
        return;
      }
    }
  }

  // --------------------------------------------------------------- retention

  /**
   * Delete recordings nobody has touched for `days`, every hour and once now.
   *
   * Event logs are not capped, so without this a long-lived relay keeps every
   * run it ever saw. A run is only ever swept when its page is gone and no
   * console has it open, so this cannot delete something being looked at.
   */
  startRetention(days: number): void {
    this.retentionDays = days;
    if (days <= 0) return;
    const sweep = () => void this.sweep(days * 24 * 60 * 60 * 1000);
    sweep();
    const timer = setInterval(sweep, 60 * 60 * 1000);
    timer.unref?.();
  }

  private async sweep(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    for (const meta of this.registry.all()) {
      if (meta.connected || meta.lastSeenAt > cutoff) continue;
      const entry = this.registry.get(meta.sessionId);
      if (!entry || entry.subscribers.size > 0 || entry.screenSubscribers.size > 0) continue;
      if (await this.registry.forget(meta.sessionId)) {
        this.broadcast({ type: 'session.removed', sessionId: meta.sessionId });
        console.log(`[bxconsole] retention: removed session-${meta.sessionId}, last seen ${new Date(meta.lastSeenAt).toISOString()}`);
      }
    }
  }

  private unsubscribeScreen(entry: SessionEntry, ws: WebSocket): void {
    if (!entry.screenSubscribers.delete(ws)) return;
    this.stopUnwatched(entry);
  }

  /** How many consoles are on a given window (one with no pick counts for all). */
  private watchersOf(entry: SessionEntry, tabId: string): number {
    let n = 0;
    for (const watched of entry.screenSubscribers.values()) if (watched === undefined || watched === tabId) n++;
    return n;
  }

  /** Stop streaming in every window no console is looking at. */
  private stopUnwatched(entry: SessionEntry): void {
    for (const [id, a] of entry.agents) {
      if (this.watchersOf(entry, id) === 0) send(a, { type: 'screen.stop' });
    }
  }

  /** The window a console command names, or the session's active one. */
  private agentFromMessage(msg: { sessionId: string; tabId?: string }): WebSocket | null {
    const entry = this.registry.get(msg.sessionId);
    return entry ? agentFor(entry, msg.tabId) : null;
  }

  /**
   * Ask any live window of the session to fetch a URL for us.
   *
   * This is the relay standing in for the console's browser: the page has the
   * network route and the cookies, the console has neither. No window
   * connected means no answer — the asset proxy then falls back to whatever is
   * already on disk, and otherwise 404s.
   */
  async fetchAsset(sessionId: string, url: string, tabId?: string): Promise<AssetData | null> {
    const entry = this.registry.get(sessionId);
    // The window the mirror is showing, when it is still here. Falling back to
    // any window of the run is right for the ordinary same-origin case and no
    // worse than refusing outright for the rest.
    const agent = entry ? (agentFor(entry, tabId) ?? agentFor(entry, undefined)) : null;
    if (!agent) return null;
    const requestId = `relay-asset-${++this.internalSeq}`;
    return new Promise<AssetData | null>((resolve) => {
      const done = (value: AssetData | null) => {
        this.pendingInternal.delete(requestId);
        clearTimeout(timer);
        resolve(value);
      };
      // A page that never answers must not hold an HTTP request open forever.
      const timer = setTimeout(() => done(null), ASSET_TIMEOUT_MS);
      this.pendingInternal.set(requestId, (reply) => done(reply.type === 'asset.data' ? reply.asset : null));
      send(agent, { type: 'asset.get', requestId, url });
    });
  }

  /**
   * The event as it should be recorded.
   *
   * Response bodies are the bulk of a long run's network.ndjson, and the file
   * is read from end to end every time someone opens the session — so a run
   * that moved a few hundred megabytes of JSON makes the Network tab slow to
   * open forever after. Anything past a couple of kilobytes therefore goes to
   * the blob store, which also collapses the identical bodies a polled
   * endpoint returns over and over into one copy.
   *
   * If the store will not take it the body stays exactly where it was. A
   * recording must never come out of this with less in it than it went in.
   */
  private async forStorage(sessionId: string, item: SequencedEvent): Promise<SequencedEvent> {
    const event = item.event;
    if (!this.blobs || !carriesBody(event)) return item;
    const held = bodyOf(event);
    if (!held) return item;
    const sha = await this.blobs.putBody(sessionId, held.bytes, held.mime).catch(() => null);
    // Refused for size, or for budget. The body stays where it was, which is
    // exactly where it would have been without any of this.
    if (!sha) return item;
    return { ...item, event: withBodyRef(event, sha, held.bytes.length) };
  }

  /** Keep a source the page returned, unless it is truncated or unreadable. */
  private async storeSource(sessionId: string, url: string, source: SourceText): Promise<void> {
    // A truncated body is not the file; storing it would answer every later
    // request with the cut-off copy.
    if (!this.blobs || source.text == null || source.truncated) return;
    const body = source.encoding === 'base64' ? Buffer.from(source.text, 'base64') : Buffer.from(source.text, 'utf8');
    await this.blobs.put(sessionId, url, body, source.mimeType ?? 'text/plain').catch(() => null);
  }

  private broadcast(msg: ServerToConsole): void {
    for (const c of this.consoles) send(c, msg);
  }
}

// -------------------------------------------------------------------- helpers

const REPLY_TYPES = new Set<string>(['eval.result', 'object.properties', 'completions.result', 'object.property', 'object.stored', 'object.json', 'node.located', 'dom.styles', 'sources.list', 'sources.text', 'asset.data']);
function isReply(msg: AgentEvent | AgentReply): msg is AgentReply {
  return REPLY_TYPES.has(msg.type);
}

/** A hello that would make the relay throw, or name a path, is ignored. */
function validHello(hello: unknown): boolean {
  if (!hello || typeof hello !== 'object') return false;
  const h = hello as { sessionId?: unknown; tabId?: unknown; viewport?: unknown };
  return (
    typeof h.sessionId === 'string' &&
    isValidSessionId(h.sessionId) &&
    typeof h.tabId === 'string' &&
    isValidSessionId(h.tabId) &&
    !!h.viewport &&
    typeof h.viewport === 'object'
  );
}

function warn(what: string, err: unknown): void {
  console.warn(`[bxconsole] dropped a bad ${what}:`, err instanceof Error ? err.message : err);
}

function parse<T>(raw: unknown): T | null {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

/** Past this, a socket is not keeping up and its queue is the relay's memory. */
const MAX_BUFFERED = 8 << 20;

function send(ws: WebSocket, msg: ServerToAgent | ServerToConsole): void {
  if (ws.readyState !== ws.OPEN) return;
  // A console on a slow link, or a tab the OS has frozen, would otherwise let
  // `ws` queue every event of a chatty page in this process's heap until it
  // runs out. Screen frames are the volume, and the next snapshot replaces
  // them, so they are what gets dropped.
  if (ws.bufferedAmount > MAX_BUFFERED) {
    if (msg.type === 'screen.event') return;
    if (ws.bufferedAmount > MAX_BUFFERED * 4) {
      console.warn('[bxconsole] closing a socket that stopped reading');
      ws.close();
      return;
    }
  }
  ws.send(JSON.stringify(msg));
}

/** A stored file, in the shape the Sources tab expects. */
function toSourceText(url: string, mime: string, body: Buffer): SourceText {
  const textual = /^(text\/|application\/(json|xml|javascript|ecmascript|x-javascript)|.*\+(json|xml)$|image\/svg)/i.test(mime);
  return textual
    ? { url, text: body.toString('utf8'), ...(mime ? { mimeType: mime } : {}) }
    : { url, text: body.toString('base64'), encoding: 'base64', ...(mime ? { mimeType: mime } : {}) };
}

/** A stored file, as the Sources tree lists it. */
function toSourceEntry(file: { url: string; mime: string }): SourceEntry {
  const mime = file.mime.toLowerCase();
  const kind: SourceEntry['kind'] = /html/.test(mime) ? 'document' : /css/.test(mime) ? 'stylesheet' : 'script';
  let label = file.url;
  try {
    const u = new URL(file.url);
    label = (u.pathname.split('/').filter(Boolean).pop() ?? u.host) + (u.search ? '?…' : '');
  } catch {
    /* keep the url as the label */
  }
  return { url: file.url, kind, inline: false, label };
}
