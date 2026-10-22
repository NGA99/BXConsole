import type { ObjectId, PropertyPreview, SerializedValue } from './values';
import type { SessionHello, SessionMeta } from './session';
import type { AccountRole, AccountSummary, Project, ProjectSummary } from './project';
import type { ScreenEvent, ScreenInput, ScreenSegment } from './screen';
import type { ElementStyles } from './dom';
import type { AssetData, KeptFile, SourceEntry, SourceText } from './sources';
import type { ProbeArrival } from './ping';

export const PROTOCOL_VERSION = 1 as const;

export type Role = 'agent' | 'console';

export const WS_PATH = {
  agent: '/ws/agent',
  console: '/ws/console',
} as const;

// ---------------------------------------------------------------------------
// Console-tab related
// ---------------------------------------------------------------------------

export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace'
  | 'dir'
  | 'dirxml'
  | 'table'
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd'
  | 'assert'
  | 'count'
  | 'countReset'
  | 'time'
  | 'timeEnd'
  | 'timeLog';

// ---------------------------------------------------------------------------
// Network-tab related
// ---------------------------------------------------------------------------

/**
 * `eventsource` and `websocket` are the two that stay open: they have no
 * response body of their own and their traffic arrives as `network.wsFrame`,
 * so the console treats them alike wherever that matters.
 */
export type NetworkKind = 'fetch' | 'xhr' | 'beacon' | 'websocket' | 'eventsource' | 'resource';

export interface NetworkTiming {
  startTime: number;
  endTime?: number;
}

/**
 * Connection phases from PerformanceResourceTiming, in performance-timeline
 * milliseconds. All zero for cross-origin resources without Timing-Allow-Origin.
 */
export interface ResourceTimingPhases {
  fetchStart: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
}

/** A PerformanceResourceTiming entry, trimmed. Headers/bodies are not visible here. */
export interface ResourceEntry {
  name: string;
  initiatorType: string;
  /** performance-timeline ms */
  startTime: number;
  duration: number;
  /** epoch ms, comparable with `ts` on fetch/xhr events */
  startedAt: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  responseStatus?: number;
  timing?: ResourceTimingPhases;
}

// ---------------------------------------------------------------------------
// Agent -> Server
// ---------------------------------------------------------------------------

/** Events the agent emits on its own. These are what gets persisted and replayed. */
export type AgentEvent =
  | {
      type: 'console.message';
      ts: number;
      level: ConsoleLevel;
      args: SerializedValue[];
      stack?: string;
      /** nesting level produced by console.group */
      groupDepth: number;
    }
  | { type: 'console.clear'; ts: number }
  | {
      type: 'error.uncaught';
      ts: number;
      message: string;
      stack?: string;
      source?: string;
      line?: number;
      col?: number;
      /** the Error's `cause`, serialised */
      cause?: SerializedValue;
    }
  | { type: 'error.unhandledrejection'; ts: number; reason: SerializedValue }
  | {
      type: 'network.request';
      ts: number;
      requestId: string;
      kind: NetworkKind;
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string | null;
      bodyTruncated?: boolean;
      /**
       * The body, held in the blob store by content hash, when it was too big
       * to keep inline. Read it from `/body/{sessionId}/{bodyRef}`. Only ever
       * on a recorded event: a live one carries the body itself.
       */
      bodyRef?: string;
      /** decoded size of the body, kept when `bodyRef` took the body itself away */
      bodyBytes?: number;
      /**
       * There was a body of `bodyBytes`, and none of it was kept.
       *
       * The blob store refuses a body that is larger than it will hold or
       * that puts the session over its budget. Those used to stay inline in
       * the event log, on the rule that a recording must never come out with
       * less than went in — which read well and meant that the budget bounded
       * nothing: past it, every body landed in a file that has no ceiling and
       * no compaction, and is read end to end whenever the session is opened.
       * Saying the body was there and is not is the smaller loss.
       */
      bodyDropped?: boolean;
      initiator?: string;
      /** call stack at fetch()/XHR send()/new WebSocket(), agent frames stripped */
      stack?: string;
    }
  | {
      type: 'network.response';
      ts: number;
      requestId: string;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      mimeType?: string;
      body?: string | null;
      bodyTruncated?: boolean;
      bodyEncoding?: 'text' | 'base64';
      /** as on network.request: the body lives in the blob store under this hash */
      bodyRef?: string;
      /** decoded size of the body, kept when `bodyRef` took the body itself away */
      bodyBytes?: number;
      /**
       * There was a body of `bodyBytes`, and none of it was kept.
       *
       * The blob store refuses a body that is larger than it will hold or
       * that puts the session over its budget. Those used to stay inline in
       * the event log, on the rule that a recording must never come out with
       * less than went in — which read well and meant that the budget bounded
       * nothing: past it, every body landed in a file that has no ceiling and
       * no compaction, and is read end to end whenever the session is opened.
       * Saying the body was there and is not is the smaller loss.
       */
      bodyDropped?: boolean;
      encodedLength?: number;
      /** ms from request start until response headers arrived (TTFB) */
      waitMs?: number;
      /** fetch Response.type: 'opaque' means a no-cors request whose status/body scripts cannot see */
      responseType?: 'basic' | 'cors' | 'default' | 'error' | 'opaque' | 'opaqueredirect';
    }
  | { type: 'network.finished'; ts: number; requestId: string; durationMs: number }
  | { type: 'network.failed'; ts: number; requestId: string; error: string }
  | { type: 'network.resource'; ts: number; entry: ResourceEntry }
  /** an <img>/<script>/<link>/<video> element fired `error`: the resource at `url` genuinely failed to load */
  | { type: 'network.resourceFailed'; ts: number; url: string; tag: string }
  /** one WebSocket frame; `data` is text or a short description for binary */
  | {
      type: 'network.wsFrame';
      ts: number;
      requestId: string;
      direction: 'sent' | 'received';
      opcode: 'text' | 'binary';
      data: string;
      length: number;
      truncated?: boolean;
    }
  | { type: 'network.wsClosed'; ts: number; requestId: string; code: number; reason: string; wasClean: boolean }
  /** document milestones as epoch ms, for the overview markers and status bar */
  | { type: 'page.timing'; ts: number; navigationStart: number; domContentLoaded?: number; load?: number }
  | { type: 'page.title'; ts: number; title: string }
  // ---- History tab: what the user did, light performance observations, app annotations
  | { type: 'interaction.click'; ts: number; selector: string; tag: string; text?: string; x: number; y: number; button: number }
  | { type: 'interaction.input'; ts: number; selector: string; tag: string; inputType?: string; value: string }
  /** non-printable keys only (Enter, Escape, Tab, arrows…); typed text is covered by interaction.input */
  | { type: 'interaction.key'; ts: number; key: string; selector: string }
  | { type: 'interaction.scroll'; ts: number; x: number; y: number }
  | { type: 'interaction.submit'; ts: number; selector: string; action?: string; method?: string }
  | { type: 'perf.longtask'; ts: number; durationMs: number }
  | { type: 'perf.layoutShift'; ts: number; value: number; hadRecentInput: boolean }
  | { type: 'perf.paint'; ts: number; name: string; startTime: number }
  /** DOM mutation counts per ~500ms bucket, for the History DOM-density lane (not the DOM itself) */
  | { type: 'dom.activity'; ts: number; mutations: number; added: number; removed: number }
  /** window.__bxconsole.mark(name, data) */
  | { type: 'mark.custom'; ts: number; name: string; data?: SerializedValue }
  /** `load`: a fresh document (clears the panels unless preserve log). `history`: pushState/popstate. */
  | { type: 'page.navigated'; ts: number; url: string; title: string; kind: 'load' | 'history' }
  | { type: 'page.visibility'; ts: number; hidden: boolean };

/** Replies to something the console asked for. Not persisted. */
export type AgentReply =
  | {
      type: 'eval.result';
      commandId: string;
      result?: SerializedValue;
      exception?: SerializedValue;
      durationMs: number;
    }
  | {
      type: 'object.properties';
      requestId: string;
      objectId: ObjectId;
      /** null when the object was garbage collected or the id is unknown */
      properties: PropertyPreview[] | null;
    }
  /** property names of `expression` (global scope when empty), for prompt autocomplete */
  | { type: 'completions.result'; requestId: string; names: string[] }
  /** a getter evaluated on demand */
  | { type: 'object.property'; requestId: string; objectId: ObjectId; name: string; value: SerializedValue }
  /** "Store object as global variable": the name it got (temp1, temp2…) */
  | { type: 'object.stored'; requestId: string; name: string | null }
  /** JSON.stringify of the live object, null when not serialisable */
  | { type: 'object.json'; requestId: string; text: string | null }
  /** screen node id of a logged DOM node, for highlighting it in the mirror; null when unknown or not streaming */
  | { type: 'node.located'; requestId: string; screenId: number | null }
  /** Styles / Computed for an element of the screen tree; null when the node is unknown */
  | { type: 'dom.styles'; requestId: string; id: number; styles: ElementStyles | null }
  | { type: 'sources.list'; requestId: string; sources: SourceEntry[] }
  | { type: 'sources.text'; requestId: string; source: SourceText }
  | { type: 'asset.data'; requestId: string; asset: AssetData };

export type AgentToServer =
  | { type: 'session.hello'; v: typeof PROTOCOL_VERSION; hello: SessionHello }
  | AgentEvent
  | AgentReply
  | ScreenEvent;

// ---------------------------------------------------------------------------
// Server -> Agent
// ---------------------------------------------------------------------------

export type ServerToAgent =
  /** `tabId` is the window id the relay settled on, which may differ from the one asked for */
  | { type: 'session.ack'; sessionId: string; tabId?: string }
  /**
   * This run is not being recorded, and retrying will not change that.
   *
   * The relay could close the socket instead, and that is the wrong answer:
   * the transport reconnects on close, so a payload with no project would
   * knock on the door every few seconds for as long as the page is open,
   * while the operator sees nothing anywhere saying why no session appeared.
   * This says so, once, and the agent gives up.
   */
  | { type: 'session.refused'; reason: string }
  /** `context.selectedNodeId` is the Elements selection (a screen node id): exposed to the expression as `$0` */
  | { type: 'eval.request'; commandId: string; expression: string; context?: { selectedNodeId?: number } }
  | { type: 'object.getProperties'; requestId: string; objectId: ObjectId }
  | { type: 'completions.request'; requestId: string; expression: string }
  | { type: 'object.invokeGetter'; requestId: string; objectId: ObjectId; name: string }
  | { type: 'object.storeGlobal'; requestId: string; objectId: ObjectId }
  | { type: 'object.toJSON'; requestId: string; objectId: ObjectId }
  | { type: 'node.locate'; requestId: string; objectId: ObjectId }
  | { type: 'node.scrollIntoView'; objectId: ObjectId }
  /** Elements tab edits; `id` is a screen node id. value null removes the attribute */
  | { type: 'dom.setAttribute'; id: number; name: string; value: string | null }
  | { type: 'dom.setText'; id: number; text: string }
  | { type: 'dom.removeNode'; id: number }
  | { type: 'dom.scrollIntoView'; id: number }
  | { type: 'dom.getStyles'; requestId: string; id: number }
  /** "Store as global variable" for an Elements node; replies object.stored */
  | { type: 'dom.storeGlobal'; requestId: string; id: number }
  | { type: 'sources.list'; requestId: string }
  | { type: 'sources.get'; requestId: string; url: string }
  /**
   * Fetch one subresource from inside the page, for the relay's asset cache.
   * The console must never load a debugged page's images, styles or fonts
   * itself: the page may be on a network the console cannot reach, behind a
   * login the console has no cookies for, or — worst — on a `localhost` that
   * means a different machine entirely.
   */
  | { type: 'asset.get'; requestId: string; url: string }
  /** fetch/XHR behaviour the console can toggle: blocked URL patterns (substring match) and cache bypass */
  | { type: 'network.configure'; blocked?: string[]; disableCache?: boolean }
  /** (re)start screen streaming: always answered with a fresh screen.snapshot */
  | { type: 'screen.start' }
  /** snapshot the current document for the recording's keyframe, without disturbing the stream */
  | { type: 'screen.keyframe' }
  | { type: 'screen.stop' }
  | { type: 'screen.input'; input: ScreenInput };

// ---------------------------------------------------------------------------
// Console -> Server
// ---------------------------------------------------------------------------

/**
 * Commands carry an optional `tabId`: which window of the session to run in.
 * Omitted means the session's most recently active window.
 */
export type ConsoleToServer =
  /** watch for connectivity probes carrying this token (see ping.ts) */
  | { type: 'ping.subscribe'; token: string }
  | { type: 'ping.unsubscribe'; token: string }
  | { type: 'sessions.list' }
  | { type: 'projects.list' }
  | { type: 'project.create'; name: string }
  | { type: 'project.rename'; projectId: string; name: string }
  /** to the trash, where it keeps its recordings until the purge */
  | { type: 'project.trash'; projectId: string }
  | { type: 'project.restore'; projectId: string }
  /** delete the project and every recording in it, for good */
  | { type: 'project.forget'; projectId: string }
  /**
   * Hand a project to another account, by account id.
   *
   * An administrator's operation, and the way an administrator reads a
   * project they do not own: by taking it, which is written down, rather than
   * by being exempt from the check. Removing an account leaves its projects
   * behind with its id still on them, and this is what clears that up.
   */
  | { type: 'project.transfer'; projectId: string; toAccountId: string }
  /**
   * Draw a new agent key for this project.
   *
   * Every payload carrying the old one stops arriving, which is the point:
   * a key that has been noticed in a page, or pasted somewhere it should not
   * have been, is a key to stop honouring.
   */
  | { type: 'project.rotateKey'; projectId: string }
  /** An administrator's list of accounts and projects; refused for anyone else. */
  | { type: 'admin.list' }
  | { type: 'account.create'; user: string; password: string; role: AccountRole }
  | { type: 'account.remove'; user: string }
  | { type: 'account.setRole'; user: string; role: AccountRole }
  /**
   * Set somebody's password, which is also how one is reset.
   *
   * It ends every cookie issued under the old one, because the cookie is
   * keyed on the stored line — so this is the way to lock an account out
   * without removing it and leaving its projects ownerless.
   */
  | { type: 'account.setPassword'; user: string; password: string }
  | { type: 'session.subscribe'; sessionId: string; replay: boolean }
  | { type: 'session.unsubscribe'; sessionId: string }
  /** move to the trash: keeps the recording, hides it from the main list */
  | { type: 'session.trash'; sessionId: string }
  /** take it back out of the trash */
  | { type: 'session.restore'; sessionId: string }
  /** delete sessions/session-{id}/ from disk and forget it, for good */
  | { type: 'session.forget'; sessionId: string }
  | { type: 'eval.request'; sessionId: string; tabId?: string; commandId: string; expression: string; context?: { selectedNodeId?: number } }
  | { type: 'object.getProperties'; sessionId: string; tabId?: string; requestId: string; objectId: ObjectId }
  | { type: 'completions.request'; sessionId: string; tabId?: string; requestId: string; expression: string }
  | { type: 'object.invokeGetter'; sessionId: string; tabId?: string; requestId: string; objectId: ObjectId; name: string }
  | { type: 'object.storeGlobal'; sessionId: string; tabId?: string; requestId: string; objectId: ObjectId }
  | { type: 'object.toJSON'; sessionId: string; tabId?: string; requestId: string; objectId: ObjectId }
  | { type: 'node.locate'; sessionId: string; tabId?: string; requestId: string; objectId: ObjectId }
  | { type: 'node.scrollIntoView'; sessionId: string; tabId?: string; objectId: ObjectId }
  | { type: 'dom.setAttribute'; sessionId: string; tabId?: string; id: number; name: string; value: string | null }
  | { type: 'dom.setText'; sessionId: string; tabId?: string; id: number; text: string }
  | { type: 'dom.removeNode'; sessionId: string; tabId?: string; id: number }
  | { type: 'dom.scrollIntoView'; sessionId: string; tabId?: string; id: number }
  | { type: 'dom.getStyles'; sessionId: string; tabId?: string; requestId: string; id: number }
  | { type: 'dom.storeGlobal'; sessionId: string; tabId?: string; requestId: string; id: number }
  | { type: 'sources.list'; sessionId: string; tabId?: string; requestId: string }
  | { type: 'sources.get'; sessionId: string; tabId?: string; requestId: string; url: string }
  /**
   * Everything the relay is holding for this session, asked once on subscribe.
   * The agent never sees this: it is the relay's own bookkeeping.
   */
  | { type: 'files.list'; sessionId: string }
  | { type: 'network.configure'; sessionId: string; tabId?: string; blocked?: string[]; disableCache?: boolean }
  | { type: 'screen.subscribe'; sessionId: string; tabId?: string }
  | { type: 'screen.unsubscribe'; sessionId: string; tabId?: string }
  | { type: 'screen.refresh'; sessionId: string; tabId?: string }
  | { type: 'screen.input'; sessionId: string; tabId?: string; input: ScreenInput }
  /**
   * DOM time travel: the recorded screen around `ts`. `seek` answers with the
   * keyframe at or before `ts` plus the ops after it; `continue` answers with
   * the ops after `ts` alone, so playback keeps running without a reload.
   */
  | { type: 'screen.replay'; sessionId: string; requestId: string; ts: number; mode: 'seek' | 'continue'; tabId?: string };

// ---------------------------------------------------------------------------
// Server -> Console
// ---------------------------------------------------------------------------

export interface SequencedEvent {
  seq: number;
  event: AgentEvent;
  /** which window in the session produced it; absent in recordings made before tabs */
  tabId?: string;
}

export type ServerToConsole =
  /** a connectivity probe reached the relay, and which one */
  | { type: 'ping.arrived'; arrival: ProbeArrival }
  /** `retentionDays`: after how long an untouched recording is deleted; 0 or absent means never */
  /**
   * `retentionDays`: how long a recording is kept at all, 0 for forever.
   * `trashPurgeDays`: how long something stays in the trash before it is
   * deleted, 0 when nothing is purged on a timer. Both are the relay's, and
   * both are sent so the console says what this relay will do rather than
   * what the defaults say.
   */
  | { type: 'sessions.snapshot'; sessions: SessionMeta[]; retentionDays?: number; trashPurgeDays?: number }
  | { type: 'session.updated'; session: SessionMeta }
  | { type: 'session.removed'; sessionId: string }
  /**
   * The projects this console may read, and which of them new runs land in.
   *
   * Sent with the session snapshot rather than waited for, because the
   * sessions are grouped by it: arriving second would mean a list that has to
   * be regrouped the moment it is drawn.
   */
  /**
   * Who this console is signed in as.
   *
   * Sent at attach, before anything else. The console had no way to know: it
   * decides what to show from the account — an administrator's screen only
   * an administrator sees — and the alternative is drawing it for everyone
   * and letting the relay refuse what it does not allow, which teaches
   * people that half the buttons do nothing.
   */
  | { type: 'console.whoami'; account: AccountSummary }
  | { type: 'projects.snapshot'; projects: Project[]; homeProjectId: string }
  | { type: 'project.updated'; project: Project }
  /**
   * This project is no longer one you can read.
   *
   * `reason` is there because the two causes want different words from a
   * console that was looking at it: a project deleted is gone for everybody,
   * and one handed over is still there and no longer yours. Who it went to
   * is deliberately not said — the person losing it may be a member with no
   * admin screen, and the account names on this relay are not theirs to
   * learn this way.
   */
  | { type: 'project.removed'; projectId: string; reason?: 'deleted' | 'transferred' }
  /**
   * Every account, and every project with its owner — an administrator's view.
   *
   * The projects come without their agent keys, because a key writes into the
   * engagement it belongs to and listing them is not reading them. See
   * ProjectSummary.
   */
  | { type: 'admin.snapshot'; accounts: AccountSummary[]; projects: ProjectSummary[] }
  /**
   * An administrator's action could not be done, and why.
   *
   * These say what went wrong where the rest of this protocol stays silent.
   * Everywhere else a refusal is about a session or project the asker may not
   * see, and naming it would confirm it exists; here the asker is an
   * administrator acting on things they are shown, so "that name is taken"
   * is the answer rather than a leak.
   */
  | { type: 'admin.error'; message: string }
  | { type: 'session.event'; sessionId: string; seq: number; event: AgentEvent; tabId?: string }
  | { type: 'session.reply'; sessionId: string; reply: AgentReply; tabId?: string }
  | { type: 'session.history'; sessionId: string; events: SequencedEvent[]; done: boolean }
  /** screen.* events; only to consoles that sent screen.subscribe */
  | { type: 'screen.event'; sessionId: string; event: ScreenEvent; tabId?: string }
  /** answer to screen.replay, read back from sessions/session-{id}/screen.ndjson */
  | { type: 'screen.replaySegment'; sessionId: string; requestId: string; segment: ScreenSegment }
  /** answer to files.list: every file the relay is holding for this session */
  | { type: 'files.list'; sessionId: string; files: KeptFile[] }
  /**
   * One more file the relay is now holding for this run.
   *
   * `files.list` is a snapshot, asked for once when a console subscribes, and
   * the collector goes on storing files as the page loads them — so without
   * this every file kept after that moment was labelled as not kept. While
   * the run was live that read "Live only", and once it ended, "Lost": the
   * Network tab telling a reader the bytes are gone while the relay has them,
   * which is the one way round that stops somebody looking.
   */
  | { type: 'files.kept'; sessionId: string; file: KeptFile }
  | { type: 'error'; message: string };

// Reserved for later: `dom.*` (Elements tab). Keep new namespaces to `<area>.<verb>`.
