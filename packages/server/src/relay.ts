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
  PROTOCOL_VERSION,
  type SessionMeta,
  type SessionHello,
  type Project,
  type AccountRole,
  type AccountSummary,
  mayAdminister,
  mayRead,
} from '@bxconsole/protocol';
import { agentFor, type SessionEntry, type SessionRegistry } from './registry';
import type { ProjectStore } from './projects';
import type { Account } from './passwd';
import type { AccountChange } from './auth';
import type { PingBoard } from './ping';
import type { BlobStore } from './blobs';
import type { AssetCollector } from './collect';
import { bodyOf, carriesBody, withBodyDropped, withBodyRef } from './net-bodies';
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
}

/**
 * The keyframe cadence is kept per window, not per run.
 *
 * `data-screen="record"` is the default, so every window of a run streams
 * from its first tick and a run that has spread holds several at once. One
 * state shared between them was wrong in every direction: a second window's
 * opening snapshot reset the first window's op count, so its next keyframe
 * never came due; the request for one went to whichever window had sent ops
 * most recently; and `awaitingKeyframe`, being shared, let one window's
 * outstanding request block every other window's.
 *
 * A window left with nothing but the keyframe it opened with is a window
 * whose only frame compaction drops first, and after that the console has
 * nothing to show for it — so this is also half of why a closed window came
 * back blank.
 */
function screenKey(sessionId: string, tabId: string): string {
  // NUL cannot occur in either id, so the pair cannot be spelled two ways.
  return `${sessionId}\u0000${tabId}`;
}

export class Relay {
  /**
   * The consoles that are connected, and who each one is.
   *
   * A Set until there was only ever one person to be. Everything a console
   * may see is decided from the account here: the snapshot it gets on
   * connect, the updates pushed to it afterwards, and the sessions its
   * messages are allowed to name. Those are three separate places and they
   * all read this one map, which is why it is the first thing to exist —
   * splitting the recordings up on disk is of no use while every console is
   * still told about all of them.
   *
   * Undefined for a socket let through before accounts existed, which no
   * longer happens; it is kept so that a missing actor fails closed rather
   * than throwing.
   */
  private readonly consoles = new Map<WebSocket, Account | undefined>();
  private readonly screenState = new Map<string, ScreenState>();
  /** which console asked for a given commandId/requestId, so replies route back */
  private readonly pendingReplies = new Map<string, WebSocket>();
  /** the blocking / cache settings in force per session, replayed to windows that join later */
  private readonly networkConfig = new Map<string, { blocked?: string[]; disableCache?: boolean }>();
  /** days a recording is kept, so the console can say so; 0 means forever */
  private retentionDays = 0;
  /** days something stays in the trash before it is deleted; 0 means never */
  private trashPurgeDays = 0;
  private projects: ProjectStore | null = null;
  private knownAccountIds: () => Set<string> = () => new Set();
  private accounts: AccountAdmin | null = null;
  /** Consoles with the administrator's screen open, so changes reach it. */
  private readonly adminWatchers = new Set<WebSocket>();
  /** ACCEPT_KEYLESS, as a project id, or null when keyless runs are refused. */
  private acceptKeyless: () => string | null = () => null;
  /** reason -> how many since it was last logged, and when that was */
  private readonly refusals = new Map<string, { count: number; last: number }>();
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
  // `tab`: whose trail this is, so a window closing clears the cursor only
  // when the cursor was its own.
  private readonly lastCursor = new Map<string, { ts: number; x: number; y: number; pressed: boolean; tab: string }>();
  /** pulls the page's own files in while the page is still there to fetch them */
  private collector: AssetCollector | null = null;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly store: SessionStore,
  ) {
    registry.onChange((entry) => this.broadcast({ type: 'session.updated', session: entry.meta }, entry.meta.sessionId));
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
        /*
         * The version is noted, not enforced.
         *
         * Rejecting a mismatch would be the usual thing and is the wrong
         * trade here: the relay serves the bundle, so agent and relay only
         * disagree when a payload pinned to an older relay is still firing
         * somewhere — mid-engagement, in a browser nobody can reach. Dropping
         * that run loses the only shot at it. Carrying the field and never
         * reading it was worse than either, because it read like a check.
         */
        if (msg.v !== PROTOCOL_VERSION) {
          console.warn(
            `[bxconsole] an agent says protocol v${String(msg.v)} and this relay speaks v${PROTOCOL_VERSION}; taking it anyway`,
          );
        }
        /*
         * Which project this run goes into, decided before anything is
         * written. A payload with no project to go to is told so and stops;
         * see landingFor and session.refused.
         */
        const landing = this.landingFor(msg.hello);
        if (!landing.ok) {
          send(ws, { type: 'session.refused', reason: landing.reason } satisfies ServerToAgent);
          this.noteRefusal(landing.reason, msg.hello);
          ws.close();
          return;
        }
        const joined = await this.registry.upsertFromHello(msg.hello, ws, landing.projectId);
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
      // This window's cadence goes with it, and only this window's: a popup
      // closing must not punch a hole in a window that is still streaming.
      this.screenState.delete(screenKey(entry.meta.sessionId, tabId));
      // The next window to stream starts its own trail rather than carrying
      // on from where a cursor in a different document happened to stop.
      if (this.lastCursor.get(entry.meta.sessionId)?.tab === tabId) {
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
    const key = screenKey(id, tabId);
    if (event.type === 'screen.snapshot') {
      // Key order matters: screen-log.ts recognises keyframe lines by their prefix.
      this.store.screen.append(id, { k: 1, ts: event.ts, tab: tabId, snapshot: event });
      this.screenState.set(key, { lastKeyframeAt: event.ts, opsSinceKeyframe: 0, awaitingKeyframe: false });
      return;
    }
    if (event.type === 'screen.cursor') {
      if (event.visible) this.recordCursor(id, event, tabId);
      return;
    }
    if (event.type !== 'screen.mutations') return;

    const state = this.screenState.get(key);
    if (!state) {
      // Ops with no keyframe behind them in this process (the relay restarted
      // under a page that keeps recording): anchor the recording first, and
      // drop these, since nothing could replay them.
      this.screenState.set(key, { lastKeyframeAt: event.ts, opsSinceKeyframe: 0, awaitingKeyframe: true });
      const a = agentFor(entry, tabId);
      if (a) send(a, { type: 'screen.keyframe' });
      return;
    }

    this.store.screen.append(id, { k: 0, ts: event.ts, tab: tabId, ops: event.ops });
    state.opsSinceKeyframe += event.ops.length;
    const due = event.ts - state.lastKeyframeAt >= KEYFRAME_MS || state.opsSinceKeyframe >= KEYFRAME_OPS;
    // Back to the window that produced these ops: a keyframe from any other
    // window would anchor this recording to the wrong document, and a window
    // that is not streaming answers nothing, latching the flag forever. The
    // key already names that window, so there is nothing to point back at.
    const streaming = agentFor(entry, tabId);
    if (due && !state.awaitingKeyframe && streaming) {
      state.awaitingKeyframe = true;
      send(streaming, { type: 'screen.keyframe' });
    }
  }

  /**
   * The last recorded frame of a window whose agent is gone.
   *
   * Per window, not per session. A run holds several and they close at
   * different times, so the last frame of the recording belongs to whichever
   * one lasted longest — and selecting a window that closed earlier showed
   * that other window's page under its name, silently. What a closed window
   * last looked like is the only thing its tab has left to show.
   */
  private async sendFrozenScreen(entry: SessionEntry, ws: WebSocket, tabId?: string): Promise<void> {
    const id = entry.meta.sessionId;
    const bounds = await this.store.screen.bounds(id, tabId);
    /*
     * The legacy single-frame file belongs to a session with no timeline at
     * all. A window that never streamed has no bounds either, and reading
     * that file for it would hand the run's frame back under this window's
     * name — the very thing freezing per window exists to stop. So it is
     * read only when the recording itself is empty.
     */
    if (!bounds && tabId !== undefined && (await this.store.screen.bounds(id)) !== null) {
      return send(ws, { type: 'error', message: 'nothing was recorded for this window' });
    }
    const frame = bounds
      ? await this.store.screen.segment(id, bounds.end, 'seek', tabId)
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
    // Kept on the window for the same reason its url is: a console that
    // attaches later never saw the event go past.
    if (event.type === 'page.visibility') {
      void this.registry.updateTab(entry.meta.sessionId, tabId, { hidden: event.hidden });
    }
    // The page just loaded a file. It can hand the bytes over now; after the
    // run ends nothing can. `collect !== false` so a recording from before the
    // option existed still collects.
    if (event.type === 'network.resource' && this.collector && entry.meta.collect !== false) {
      this.collector.offer(entry.meta.sessionId, event.entry.name, tabId);
    }
  }

  /** Sample the pointer into the recording; see CURSOR_SAMPLE_MS for why. */
  private recordCursor(sessionId: string, event: ScreenCursor, tabId: string): void {
    const last = this.lastCursor.get(sessionId);
    const moved = !last || Math.abs(event.x - last.x) >= CURSOR_MIN_PX || Math.abs(event.y - last.y) >= CURSOR_MIN_PX;
    const pressChanged = !last || last.pressed !== event.pressed;
    const due = !last || event.ts - last.ts >= CURSOR_SAMPLE_MS;
    if (!pressChanged && (!moved || !due)) return;

    this.lastCursor.set(sessionId, { ts: event.ts, x: event.x, y: event.y, pressed: event.pressed, tab: tabId });
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
      tab: tabId,
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

  attachConsole(ws: WebSocket, actor?: Account): void {
    this.consoles.set(ws, actor);
    // Who they are, before what they can see: the console draws its screens
    // from the account, so telling it second means drawing them twice.
    if (actor) send(ws, { type: 'console.whoami', account: { id: actor.id, user: actor.user, role: actor.role } });
    this.sendProjects(ws, actor);
    send(ws, {
      type: 'sessions.snapshot',
      sessions: this.visibleTo(actor),
      retentionDays: this.retentionDays,
      trashPurgeDays: this.trashPurgeDays,
    });

    ws.on('message', (raw) => {
      const msg = parse<ConsoleToServer>(raw);
      if (!msg || typeof msg.type !== 'string') return;
      void this.handleConsoleMessage(ws, msg).catch((err) => warn('console message', err));
    });

    ws.on('close', () => {
      this.consoles.delete(ws);
      this.adminWatchers.delete(ws);
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
    /*
     * Keep each console's manifest current.
     *
     * Only to the consoles subscribed to that run, and only the one file, so
     * a page pulling in two hundred resources costs two hundred small
     * messages to whoever is actually watching rather than a full manifest
     * each time.
     */
    blobs.onKept = (sessionId, file) => {
      const entry = this.registry.get(sessionId);
      if (!entry) return;
      for (const sub of entry.subscribers) send(sub, { type: 'files.kept', sessionId, file });
    };
  }

  /**
   * The project list, which is what decides who sees what.
   *
   * Without it every console sees every session, which is what the relay did
   * before projects existed. Boot wires it in before the first socket is
   * accepted, so that state is not reachable in practice; it is written this
   * way round because the tests build a relay with only the pieces they are
   * about.
   */
  useProjects(projects: ProjectStore): void {
    this.projects = projects;
  }

  /**
   * The account ids that exist, for checking the target of a transfer.
   *
   * A callback rather than the account list itself: `.passwd` is re-read when
   * it changes, so an answer taken once at boot would go stale the first time
   * somebody was added.
   */
  useAccountIds(ids: () => Set<string>): void {
    this.knownAccountIds = ids;
  }

  /** The account list, for the administrator's screen to read and change. */
  useAccounts(accounts: AccountAdmin): void {
    this.accounts = accounts;
  }

  /**
   * Where a payload with no project key lands, or null to refuse it.
   *
   * The transition, and it is meant to be temporary. Keys did not exist when
   * the payloads now in flight were built, and those are in browsers nobody
   * can reach — a relay that refused them would drop the engagements it was
   * installed for. So an operator names a project to catch them, replaces
   * the payloads, and unsets it.
   *
   * Off by default, because the other way round is worse: a relay that
   * silently accepts any keyless run puts every stray payload anybody ever
   * pasted into one shared project, which is the thing projects exist to
   * stop.
   */
  useKeylessLanding(projectId: () => string | null): void {
    this.acceptKeyless = projectId;
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
    /*
     * One gate for the lot.
     *
     * Twenty-eight of these carry a sessionId, and checking each where it is
     * handled would mean twenty-eight chances to forget — the kind of mistake
     * that is found by someone seeing another team's run rather than by a
     * test. They all arrive here, so this is the place to ask.
     */
    if ('sessionId' in msg && typeof msg.sessionId === 'string' && !this.mayRead(ws, msg.sessionId)) return;
    /*
     * And the same for the ones that name a project instead of a session.
     *
     * A floor, not the whole check: every one of these handlers asks again
     * for what it specifically needs, which for all but the list is being
     * the owner rather than merely allowed to read. This is here so that the
     * next project message added is refused before it is written rather than
     * after somebody notices.
     *
     * The transfer is the exception, and it has to be here rather than in
     * the handler. It is what an administrator does to a project they cannot
     * read — reassigning what a removed account left behind, or taking one
     * deliberately instead of being quietly exempt from the check — so
     * requiring read access to send it would make it the one operation that
     * cannot be performed by the only person who may perform it. Its handler
     * asks for the admin role instead.
     */
    if (msg.type !== 'project.transfer' && 'projectId' in msg && typeof msg.projectId === 'string' && !this.projectFor(ws, msg.projectId)) {
      return;
    }
    switch (msg.type) {
      case 'ping.subscribe': {
        /*
         * Only the account the token was handed to.
         *
         * This is the one console message that names something other than a
         * session or a project, so the gates above do not cover it — and it
         * went uncovered: a probe record holds a client IP and the URL of
         * the page it fired on, and any signed-in account could ask for any
         * token's.
         */
        const actor = this.consoles.get(ws);
        if (!this.pingBoard?.isOwnedBy(msg.token, actor?.id)) return;
        let watched = this.pingWatchers.get(ws);
        if (!watched) {
          watched = new Set();
          this.pingWatchers.set(ws, watched);
        }
        watched.add(msg.token);
        // Whatever already landed, so a console opened late is not told nothing happened.
        for (const arrival of this.pingBoard.since(msg.token, actor?.id)) send(ws, { type: 'ping.arrived', arrival });
        return;
      }

      case 'ping.unsubscribe':
        this.pingWatchers.get(ws)?.delete(msg.token);
        return;

      case 'sessions.list':
        // Through visibleTo, like the snapshot at attach: this is the same
        // answer asked for again, and it went straight to the registry.
        send(ws, {
          type: 'sessions.snapshot',
          sessions: this.visibleTo(this.consoles.get(ws)),
          retentionDays: this.retentionDays,
          trashPurgeDays: this.trashPurgeDays,
        });
        return;

      case 'projects.list':
        this.sendProjects(ws, this.consoles.get(ws));
        return;

      case 'project.create': {
        const actor = this.consoles.get(ws);
        if (!this.projects || !actor) return;
        const made = await this.projects.create(msg.name, actor.id);
        /*
         * To everyone who may read it, which for a new project is its maker
         * and nobody else — but that is still more than the socket it was
         * asked on. Someone with the console open in two windows should see
         * the project in both, and sending it back to the one that asked
         * left the other one a refresh behind.
         */
        this.tellAboutProject(made);
        this.refreshAdmins();
        return;
      }

      case 'project.rename': {
        const project = this.mayAdministerFrom(ws, msg.projectId);
        if (!project) return;
        const next = await this.projects!.update(msg.projectId, { name: msg.name });
        if (next) this.tellAboutProject(next);
        this.refreshAdmins();
        return;
      }

      case 'project.trash':
      case 'project.restore': {
        if (!this.mayAdministerFrom(ws, msg.projectId)) return;
        const next = await this.projects!.setTrashed(msg.projectId, msg.type === 'project.trash');
        if (next) this.tellAboutProject(next);
        this.refreshAdmins();
        return;
      }

      case 'project.forget': {
        if (!this.mayAdministerFrom(ws, msg.projectId)) return;
        // Before a single recording goes: the home project cannot be
        // deleted, and learning that afterwards would leave it emptied.
        if (!this.projects!.canRemove(msg.projectId)) return;
        /*
         * Who to tell the project went, while there is still a project to be
         * visible. Each recording's own audience is taken as it goes, which
         * still works because the project is removed last.
         */
        const audience = this.projectAudience(msg.projectId);
        const inIt = this.registry.all().filter((m) => this.homeAwareProject(m) === msg.projectId);
        /*
         * The recordings first, the project last.
         *
         * Which way round this goes decides what a relay killed in the
         * middle of it leaves behind. Project first leaves recordings naming
         * a project that no longer exists, and a recording whose project
         * cannot be found is readable by nobody — invisible for good, with
         * no way to ask for it again. Recordings first leaves a project with
         * fewer runs in it, still listed, still deletable: asking again
         * finishes the job.
         */
        for (const meta of inIt) await this.forgetAndTell(meta.sessionId);
        if (!(await this.projects!.remove(msg.projectId))) return;
        this.sendTo(audience, { type: 'project.removed', projectId: msg.projectId, reason: 'deleted' });
        this.refreshAdmins();
        return;
      }

      case 'project.rotateKey': {
        if (!this.mayAdministerFrom(ws, msg.projectId)) return;
        const next = await this.projects!.rotateKey(msg.projectId);
        if (next) this.tellAboutProject(next);
        return;
      }

      case 'project.transfer': {
        /*
         * An administrator's operation, and the only way to reach a project
         * you do not own. Deliberately not a read exemption: the owner field
         * changes, in a file, so the handover is a thing that happened rather
         * than a permission nobody can see.
         */
        const actor = this.consoles.get(ws);
        if (!this.projects || actor?.role !== 'admin') return;
        const project = this.projects.get(msg.projectId);
        if (!project) return;
        if (!this.knownAccountIds().has(msg.toAccountId)) return;
        const before = this.projectAudience(msg.projectId);
        const next = await this.projects.update(msg.projectId, { owner: msg.toAccountId });
        if (!next) return;
        // Both sides: whoever could see it before, so the ones who just lost
        // it hear that it is gone, and whoever can see it now.
        this.sendTo(before, { type: 'project.removed', projectId: msg.projectId, reason: 'transferred' });
        this.tellAboutProject(next);
        this.refreshAdmins();
        return;
      }

      case 'admin.list': {
        if (this.consoles.get(ws)?.role !== 'admin') return;
        // Remembered, so that anything changing the account list or the
        // projects pushes it again. Without that the screen showed the state
        // it was opened with: a transfer landed on disk and the table went on
        // naming the old owner, which is the one thing that screen is for.
        this.adminWatchers.add(ws);
        this.sendAdmin(ws);
        return;
      }

      case 'account.create':
      case 'account.remove':
      case 'account.setRole':
      case 'account.setPassword': {
        /*
         * Changing the account list, which is `.passwd` on disk.
         *
         * The relay re-reads that file when its mtime moves, so none of this
         * needs a restart — and nowhere does that matter more: a restart
         * drops every agent socket, and the runs those pages are producing
         * cannot be started again.
         */
        const actor = this.consoles.get(ws);
        if (actor?.role !== 'admin' || !this.accounts) return;
        const reason = await this.accounts.change(changeFor(msg));
        if (reason !== null) return send(ws, { type: 'admin.error', message: reason });
        // To every administrator's screen, not only the one that asked: two
        // of them open should not disagree about who exists.
        this.refreshAdmins();
        return;
      }

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
          if (entry) this.broadcast({ type: 'session.updated', session: entry.meta }, entry.meta.sessionId);
        }
        return;
      }

      case 'session.forget':
        await this.forgetAndTell(msg.sessionId);
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
        if (!agent) return void this.sendFrozenScreen(entry, ws, msg.tabId);
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
        const segment = await this.store.screen.segment(msg.sessionId, msg.ts, msg.mode, msg.tabId);
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

  /**
   * Empty the trash on a timer: 0 to leave it to be emptied by hand.
   *
   * A timer of its own rather than a pass inside the retention sweep,
   * because they are different policies — retention is about how old a
   * recording is, this is about how long ago somebody threw it away — and a
   * relay can want one without the other.
   *
   * It runs once at startup as well as hourly. A relay that was off for a
   * fortnight should empty the trash when it comes back, not an hour later.
   */
  startTrashPurge(days: number): void {
    this.trashPurgeDays = days;
    if (days <= 0) return;
    const purge = () => void this.purgeTrash(days * 24 * 60 * 60 * 1000).catch((err) => warn('trash purge', err));
    purge();
    const timer = setInterval(purge, 60 * 60 * 1000);
    timer.unref?.();
  }

  /**
   * Empty the trash of anything that has been in it long enough.
   *
   * The only thing in this relay that deletes a recording on a timer, which
   * is why it is narrow: it touches nothing that is not in the trash, and
   * being in the trash is a thing somebody did on purpose and can undo. A
   * run that starts talking again comes out of the trash by itself, so a
   * page that is still live cannot be purged out from under its own session.
   *
   * Unlike the retention sweep above, a console watching does not stay its
   * hand. Retention is the relay deciding a recording has aged out and can
   * afford to wait; this is a deletion somebody asked for a week ago, and
   * one forgotten open tab should not hold it off for ever. A watching
   * console is told, the same way it is told when somebody deletes a run by
   * hand.
   */
  private async purgeTrash(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    /*
     * Projects first: purging one takes every recording in it, so doing the
     * loose sessions first would walk rows that are about to go anyway — and
     * would report them twice.
     */
    for (const project of [...(this.projects?.all() ?? [])]) {
      if (project.trashedAt === undefined || project.trashedAt > cutoff) continue;
      // The home project cannot be trashed and so should never be here; if
      // it somehow is, it cannot be removed either and skipping it is the
      // only answer that does not empty it without deleting it.
      if (!this.projects!.canRemove(project.id)) continue;
      const inIt = this.registry.all().filter((m) => this.homeAwareProject(m) === project.id);
      const audience = this.projectAudience(project.id);
      for (const meta of inIt) await this.forgetAndTell(meta.sessionId);
      if (await this.projects!.remove(project.id)) {
        this.sendTo(audience, { type: 'project.removed', projectId: project.id, reason: 'deleted' });
        console.log(
          `[bxconsole] trash: deleted project "${project.name}" and ${inIt.length} recording(s), trashed ${new Date(project.trashedAt).toISOString()}`,
        );
      }
    }

    for (const meta of this.registry.all()) {
      if (meta.trashedAt === undefined || meta.trashedAt > cutoff) continue;
      if (await this.forgetAndTell(meta.sessionId)) {
        console.log(`[bxconsole] trash: deleted session-${meta.sessionId}, trashed ${new Date(meta.trashedAt).toISOString()}`);
      }
    }
    this.refreshAdmins();
  }

  /** Delete a recording and tell whoever could see it, audience taken first. */
  private async forgetAndTell(sessionId: string): Promise<boolean> {
    const audience = this.audienceFor(sessionId);
    if (!(await this.registry.forget(sessionId))) return false;
    this.networkConfig.delete(sessionId);
    // Every window's cadence, since the map is keyed by the pair.
    for (const key of this.screenState.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.screenState.delete(key);
    }
    this.lastCursor.delete(sessionId);
    this.sendTo(audience, { type: 'session.removed', sessionId });
    return true;
  }

  private async sweep(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    for (const meta of this.registry.all()) {
      if (meta.connected || meta.lastSeenAt > cutoff) continue;
      const entry = this.registry.get(meta.sessionId);
      if (!entry || entry.subscribers.size > 0 || entry.screenSubscribers.size > 0) continue;
      // The same deletion the trash purge and a hand-delete do. It used to
      // be written out here without the three maps keyed by session id, so a
      // swept recording left its network config and screen state behind for
      // the life of the process.
      if (await this.forgetAndTell(meta.sessionId)) {
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
   * If the store will not take it — too large, or the session is past its
   * budget — the body is dropped rather than left inline. Leaving it was the
   * older behaviour and it made the budget meaningless: past it every body
   * went to this very file, which has no ceiling and is read end to end on
   * every open. See net-bodies.ts.
   */
  private async forStorage(sessionId: string, item: SequencedEvent): Promise<SequencedEvent> {
    const event = item.event;
    if (!this.blobs || !carriesBody(event)) return item;
    const held = bodyOf(event);
    if (!held) return item;
    const sha = await this.blobs.putBody(sessionId, held.bytes, held.mime).catch(() => null);
    // Refused for size or for budget: keep the size and the fact of it, not
    // the bytes. The event log is the one file here that nothing bounds.
    if (!sha) return { ...item, event: withBodyDropped(event, held.bytes.length) };
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

  /**
   * The sessions an account may see.
   *
   * The project each run is in decides it, and a run with no project of its
   * own is read as being in the home one — which is where the migration put
   * the recordings that were here before projects were. Four things read
   * this: the snapshot a console gets on connect, the same list asked for
   * again, the updates pushed to it, and whether a message may name a
   * session at all.
   */
  protected visibleTo(actor: Account | undefined): SessionMeta[] {
    const projects = this.projects;
    if (!projects) return this.registry.all();
    return this.registry.all().filter((m) => projects.maySeeSessionIn(m.projectId, actor?.id));
  }

  /** Whether this console may read this project, and the project itself. */
  private projectFor(ws: WebSocket, projectId: string): Project | null {
    const actor = this.consoles.get(ws);
    const project = this.projects?.get(projectId);
    if (!project || !mayRead(project, actor?.id)) return null;
    return project;
  }

  /**
   * The project, if this console may change it and not merely read it.
   *
   * Being shared a project is being shared its recordings. Renaming,
   * trashing and deleting are the owner's, so someone invited to read an
   * engagement cannot delete it.
   */
  private mayAdministerFrom(ws: WebSocket, projectId: string): Project | null {
    const project = this.projectFor(ws, projectId);
    if (!project) return null;
    return mayAdminister(project, this.consoles.get(ws)?.id) ? project : null;
  }

  /**
   * Which project a run that has just said hello belongs in.
   *
   * Three answers, in this order, and the order is the point.
   *
   * A run that already exists keeps the project it is in, and the key is not
   * consulted. Sessions do not move between projects — and if a key could
   * move one, anybody holding any key could pull somebody else's run into
   * their own project by reconnecting to its id. That also means a reconnect
   * is accepted without a key: it is not creating anything, and a payload
   * that knows a session id can already append to that run whatever it
   * carries.
   *
   * A key that matches a project puts the run there. A key that matches
   * nothing is refused rather than quietly treated as keyless, because the
   * two mean different things: no key is an old payload, and a wrong key is
   * a rotated or mistyped one, and an operator chasing a missing session
   * needs to be told which.
   *
   * No key at all falls to ACCEPT_KEYLESS, which is how an engagement
   * already in flight keeps arriving while its payloads are replaced. Unset,
   * the run is refused.
   */
  private landingFor(hello: SessionHello): { ok: true; projectId?: string } | { ok: false; reason: string } {
    const projects = this.projects;
    if (!projects) return { ok: true };

    const known = this.registry.get(hello.sessionId)?.meta.projectId;
    if (known !== undefined) return { ok: true, projectId: known };

    if (hello.key) {
      const project = projects.byAgentKey(hello.key);
      if (project) return { ok: true, projectId: project.id };
      return { ok: false, reason: 'the project key in this payload is not one this relay knows' };
    }
    const keyless = this.acceptKeyless();
    if (keyless) return { ok: true, projectId: keyless };
    return { ok: false, reason: 'this payload carries no project key, and the relay is not accepting keyless runs' };
  }

  /**
   * Say a run was turned away, without letting it fill the log.
   *
   * The thing to avoid in both directions. Silence here is the failure this
   * tool is worst at — a payload that fires and never appears, with nothing
   * anywhere saying why — and the operator has no other way to find out,
   * because the only other party to the conversation is a victim's browser.
   * But a payload mass-fired across a target writes one of these per page,
   * so each reason is reported once a minute with however many it stood for.
   */
  private noteRefusal(reason: string, hello: SessionHello): void {
    const now = Date.now();
    const seen = this.refusals.get(reason) ?? { count: 0, last: 0 };
    seen.count++;
    if (now - seen.last < REFUSAL_LOG_MS) {
      this.refusals.set(reason, seen);
      return;
    }
    const also = seen.count > 1 ? ` (and ${seen.count - 1} more like it)` : '';
    console.warn(`[bxconsole] refused a run from ${hello.url}: ${reason}${also}`);
    this.refusals.set(reason, { count: 0, last: now });
  }

  /** Which project a run counts as being in, home standing in for none. */
  private homeAwareProject(meta: SessionMeta): string | undefined {
    return meta.projectId ?? this.projects?.homeId() ?? undefined;
  }

  /**
   * The account list and every project with its owner.
   *
   * Admin only, and checked by every caller. The projects are summaries
   * without their agent keys: reassigning a project is an administrator's
   * job and reading one is not, and a key writes into the engagement it
   * belongs to.
   */
  /**
   * Push the administrator's view again, to whoever has it open.
   *
   * Called from everything that changes what is on it — the account list, and
   * every project's name, owner and existence. A project is renamed by its
   * owner and transferred by an administrator, so the two screens change each
   * other's contents and neither can be left to find out on its own.
   */
  private refreshAdmins(): void {
    for (const ws of this.adminWatchers) {
      if (this.consoles.get(ws)?.role === 'admin') this.sendAdmin(ws);
      else this.adminWatchers.delete(ws);
    }
  }

  private sendAdmin(ws: WebSocket): void {
    if (!this.accounts || !this.projects) return;
    const counts = new Map<string, number>();
    const home = this.projects.homeId();
    for (const meta of this.registry.all()) {
      const id = meta.projectId ?? home;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    send(ws, {
      type: 'admin.snapshot',
      accounts: this.accounts.summaries(),
      projects: this.projects.all().map((p) => ({
        id: p.id,
        name: p.name,
        owner: p.owner,
        sharedWith: p.sharedWith,
        createdAt: p.createdAt,
        ...(p.trashedAt !== undefined ? { trashedAt: p.trashedAt } : {}),
        sessions: counts.get(p.id) ?? 0,
      })),
    });
  }

  private sendProjects(ws: WebSocket, actor: Account | undefined): void {
    if (!this.projects) return;
    const mine = this.projects.visibleTo(actor?.id);
    const home = this.projects.homeId();
    send(ws, {
      type: 'projects.snapshot',
      projects: mine,
      /*
       * Only when it is one of theirs.
       *
       * This is where a new run lands, so a console that can see the home
       * project needs to know which one it is. A console that cannot has no
       * use for it and would be holding the id of someone else's engagement
       * — which was going out to every account, including ones that own
       * nothing at all.
       */
      homeProjectId: home !== null && mine.some((p) => p.id === home) ? home : '',
    });
  }

  /** The consoles that may read this project, resolved now. */
  private projectAudience(projectId: string): WebSocket[] {
    const project = this.projects?.get(projectId);
    if (!project) return [];
    const out: WebSocket[] = [];
    for (const [c, actor] of this.consoles) if (mayRead(project, actor?.id)) out.push(c);
    return out;
  }

  /** A project changed: to everyone who may read it as it now stands. */
  private tellAboutProject(project: Project): void {
    for (const [c, actor] of this.consoles) {
      if (mayRead(project, actor?.id)) send(c, { type: 'project.updated', project });
    }
  }

  /** Whether a console may act on this session at all. */
  private mayRead(ws: WebSocket, sessionId: string): boolean {
    const actor = this.consoles.get(ws);
    return this.visibleTo(actor).some((m) => m.sessionId === sessionId);
  }

  /**
   * The consoles that may see this session, as a list taken now.
   *
   * Taken now because the answer depends on the session still existing: the
   * one message that has to reach a console is that a session is gone, and
   * asking who may see it after it has been deleted answers nobody. So the
   * audience for a removal is resolved before the removal.
   */
  private audienceFor(sessionId: string): WebSocket[] {
    const out: WebSocket[] = [];
    for (const [c, actor] of this.consoles) {
      if (this.visibleTo(actor).some((m) => m.sessionId === sessionId)) out.push(c);
    }
    return out;
  }

  private sendTo(audience: readonly WebSocket[], msg: ServerToConsole): void {
    for (const c of audience) send(c, msg);
  }

  /**
   * To every console that may see what this is about.
   *
   * It used to go to all of them, which pushed each session's whole meta —
   * url, title, user agent, its windows — to everyone connected, every time
   * a page so much as changed its title.
   */
  private broadcast(msg: ServerToConsole, about: string): void {
    this.sendTo(this.audienceFor(about), msg);
  }
}

// -------------------------------------------------------------------- helpers

/**
 * What the relay needs of the account list, and no more.
 *
 * An interface rather than ConsoleAuth itself: the relay has no business
 * with cookies or password verification, and naming the two methods it does
 * use keeps the tests from having to build an auth to exercise a socket.
 */
export interface AccountAdmin {
  summaries(): AccountSummary[];
  change(change: AccountChange): Promise<string | null>;
}

/** The console's message as the one shape `change` takes. */
function changeFor(
  msg:
    | { type: 'account.create'; user: string; password: string; role: AccountRole }
    | { type: 'account.remove'; user: string }
    | { type: 'account.setRole'; user: string; role: AccountRole }
    | { type: 'account.setPassword'; user: string; password: string },
): AccountChange {
  switch (msg.type) {
    case 'account.create':
      return { op: 'create', user: msg.user, password: msg.password, role: msg.role };
    case 'account.remove':
      return { op: 'remove', user: msg.user };
    case 'account.setRole':
      return { op: 'setRole', user: msg.user, role: msg.role };
    case 'account.setPassword':
      return { op: 'setPassword', user: msg.user, password: msg.password };
  }
}

/** At most one line a minute per reason, however many runs it stood for. */
const REFUSAL_LOG_MS = 60_000;

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
