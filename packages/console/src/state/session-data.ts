/**
 * Per-session event buffers, one zustand store per session, created lazily.
 *
 * Console entries are a flat list in seq order. Network entries are keyed by
 * requestId because request/response/finished arrive as separate events and
 * the Network tab shows one row per request.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { severityOf } from '../panels/console/group-tree';
import type { AgentEvent, KeptFile, ResourceEntry, SequencedEvent, SerializedValue } from '@bxconsole/protocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Entries created by the console UI itself (eval prompt), not by the agent. */
export type LocalConsoleEntry =
  | { type: 'eval.command'; seq: number; ts: number; expression: string; tabId?: string }
  | { type: 'eval.result'; seq: number; ts: number; result?: SerializedValue; exception?: SerializedValue; tabId?: string }
  /** Chrome logs failed requests in the console ("GET url 404 (Not Found)"); derived from network events */
  | {
      type: 'network.error';
      seq: number;
      ts: number;
      tabId?: string;
      requestId: string;
      method: string;
      url: string;
      status?: number;
      statusText?: string;
      error?: string;
    };

/** Which window of the session an entry came from; absent in older recordings. */
export interface HasTab {
  tabId?: string;
}

export type ConsoleEntry =
  | (Extract<
      AgentEvent,
      { type: 'console.message' | 'console.clear' | 'error.uncaught' | 'error.unhandledrejection' | 'page.navigated' }
    > & { seq: number; tabId?: string })
  | LocalConsoleEntry;

export type WsFrame = Extract<AgentEvent, { type: 'network.wsFrame' }>;

/** Events the History tab draws on its own lanes (console/network lanes read the other buffers). */
export type HistoryEntry = Extract<
  AgentEvent,
  {
    type:
      | 'interaction.click'
      | 'interaction.input'
      | 'interaction.key'
      | 'interaction.scroll'
      | 'interaction.submit'
      | 'perf.longtask'
      | 'perf.layoutShift'
      | 'perf.paint'
      | 'dom.activity'
      | 'mark.custom'
      | 'page.title'
      | 'page.navigated';
  }
> & { seq: number; tabId?: string };

export interface NetworkEntry {
  requestId: string;
  seq: number;
  tabId?: string;
  request: Extract<AgentEvent, { type: 'network.request' }>;
  response?: Extract<AgentEvent, { type: 'network.response' }>;
  finished?: Extract<AgentEvent, { type: 'network.finished' }>;
  failed?: Extract<AgentEvent, { type: 'network.failed' }>;
  /** metadata-only rows from PerformanceObserver (img/script/css...) */
  resource?: ResourceEntry;
  /** WebSocket messages, newest last (capped) */
  frames?: WsFrame[];
  closed?: Extract<AgentEvent, { type: 'network.wsClosed' }>;
}

export interface PageTiming {
  navigationStart?: number;
  domContentLoaded?: number;
  load?: number;
}

interface SessionDataState {
  historyLoaded: boolean;
  /** keep console/network across document loads (DevTools "Preserve log") */
  preserveLog: boolean;
  /** DevTools record button: when off, network events are dropped */
  networkRecording: boolean;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /**
   * Urls the relay is holding a copy of, so the Network tab can tell at a
   * glance which bodies are still readable. Empty until the manifest lands,
   * which reads as "not kept" — the honest answer before we have been told.
   */
  keptFiles: Set<string>;
  addKeptFile(file: KeptFile): void;
  networkIndex: Record<string, number>;
  history: HistoryEntry[];
  /** Load milestones of the window the UI points at; each window has its own. */
  pageTiming: PageTiming;
  /** …and the same keyed by window, since a session can hold several. */
  pageTimingByTab: Record<string, PageTiming>;
  /**
   * How many events each window of the run has produced.
   *
   * Counted here rather than measured off the arrays below, because those are
   * trimmed: a long run keeps its last 5,000 console rows and 2,000 requests,
   * so their lengths stop being the answer well before a busy window does.
   * Nothing is added to the protocol for it — every event already arrives
   * with the window that produced it.
   */
  eventsByTab: Record<string, number>;
  /** set while a recording is being replayed in bulk: appends mutate in place */
  batching: boolean;
  /** running totals for the tab strip badge, so nothing has to rescan the buffer */
  issues: { errors: number; warnings: number };
  /** element load failures seen before their resource-timing entry arrived */
  pendingResourceFailures: string[];
  /** DevTools "Block request URL" patterns (substring) and "Disable cache", mirrored to the agent */
  blockedPatterns: string[];
  disableCache: boolean;
  setBlockedPatterns(p: string[]): void;
  setDisableCache(on: boolean): void;
  reset(): void;
  clearConsole(): void;
  clearNetwork(): void;
  setKeptFiles(files: KeptFile[]): void;
  clearHistory(): void;
  setPreserveLog(on: boolean): void;
  setNetworkRecording(on: boolean): void;
  push(seq: number, event: AgentEvent, tabId?: string): void;
  pushMany(events: SequencedEvent[], done: boolean): void;
  /** `tabId`: the window the prompt was pointed at, so the entry shows under that tab only */
  pushLocal(entry: DistributiveOmit<LocalConsoleEntry, 'seq'>, tabId?: string): void;
}

const MAX_CONSOLE = 5000;
const MAX_NETWORK = 2000;
const MAX_FRAMES = 500;
const MAX_HISTORY = 20000;
/** Local entries sort after anything the agent can produce. */
let localSeq = 1e12;

const stores = new Map<string, UseBoundStore<StoreApi<SessionDataState>>>();

/** Drop a deleted session's buffers; otherwise every session ever opened stays in memory. */
export function dropSessionData(sessionId: string): void {
  stores.delete(sessionId);
}

export function sessionData(sessionId: string): UseBoundStore<StoreApi<SessionDataState>> {
  let store = stores.get(sessionId);
  if (!store) {
    store = createSessionDataStore(sessionId);
    stores.set(sessionId, store);
  }
  return store;
}

/**
 * What a session's view remembers between visits. Named for the network
 * settings it started as; it holds anything that would be irritating to set
 * again every time the console is reopened.
 */
interface PersistedNetworkConfig {
  blocked: string[];
  disableCache: boolean;
  /**
   * On by default, unlike DevTools. A page being debugged here navigates on
   * its own and the run carries on through it, so clearing the console at
   * every load throws away most of what a run said — and the operator is
   * usually not watching at the moment it happens.
   */
  preserveLog: boolean;
}
const configKey = (sessionId: string) => `bxconsole.network.config.${sessionId}`;
function loadConfig(sessionId: string): PersistedNetworkConfig {
  try {
    return { blocked: [], disableCache: false, preserveLog: true, ...(JSON.parse(localStorage.getItem(configKey(sessionId)) ?? '{}') as Partial<PersistedNetworkConfig>) };
  } catch {
    return { blocked: [], disableCache: false, preserveLog: true };
  }
}
function saveConfig(sessionId: string, c: PersistedNetworkConfig): void {
  try {
    localStorage.setItem(configKey(sessionId), JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

function createSessionDataStore(sessionId: string) {
  const config = loadConfig(sessionId);
  return create<SessionDataState>((set, get) => ({
    historyLoaded: false,
    preserveLog: config.preserveLog,
    networkRecording: true,
    console: [],
    network: [],
    keptFiles: new Set<string>(),
    networkIndex: {},
    history: [],
    pageTiming: {},
    pageTimingByTab: {},
    eventsByTab: {},
    batching: false,
    issues: { errors: 0, warnings: 0 },
    pendingResourceFailures: [],
    blockedPatterns: config.blocked,
    disableCache: config.disableCache,
    setBlockedPatterns: (p) => {
      set({ blockedPatterns: p });
      saveConfig(sessionId, { blocked: p, disableCache: get().disableCache, preserveLog: get().preserveLog });
    },
    setDisableCache: (on) => {
      set({ disableCache: on });
      saveConfig(sessionId, { blocked: get().blockedPatterns, disableCache: on, preserveLog: get().preserveLog });
    },

    reset: () =>
      set({ historyLoaded: false, console: [], network: [], networkIndex: {}, history: [], pageTiming: {}, pageTimingByTab: {}, eventsByTab: {}, issues: { errors: 0, warnings: 0 }, pendingResourceFailures: [] }),
    clearConsole: () => set({ console: [], issues: { errors: 0, warnings: 0 } }),
    setKeptFiles: (files: KeptFile[]) => set({ keptFiles: new Set(files.map((f) => f.url)) }),
    addKeptFile: (file: KeptFile) =>
      set((s) => (s.keptFiles.has(file.url) ? s : { keptFiles: new Set(s.keptFiles).add(file.url) })),
    clearNetwork: () => set({ network: [], networkIndex: {}, pendingResourceFailures: [] }),
    clearHistory: () => set({ history: [] }),
    setPreserveLog: (on) => {
      set({ preserveLog: on });
      saveConfig(sessionId, { blocked: get().blockedPatterns, disableCache: get().disableCache, preserveLog: on });
    },
    setNetworkRecording: (on) => set({ networkRecording: on }),

    push: (seq, event, tabId) => {
      const next = applyEvent(get(), seq, event, tabId);
      /*
       * Counted whether or not the event changed anything on screen. A
       * resource timing entry that only lands in an array, a cursor sample,
       * a navigation that clears the log — all of them are things the window
       * did, which is what the number in its tab is for.
       */
      const counted = tabId ? { eventsByTab: { ...get().eventsByTab, [tabId]: (get().eventsByTab[tabId] ?? 0) + 1 } } : null;
      if (next || counted) set({ ...next, ...counted });
    },

    /**
     * Replaying a recording arrives in chunks of hundreds of events, and
     * applying them one at a time copied the whole console array per message
     * and rebuilt the request index per request: quadratic in the length of
     * the run, with nothing on screen until it finished. Here the arrays are
     * private until the end, so appends are pushes and the index is built once.
     */
    pushMany: (events, done) => {
      const start = get();
      const draft: SessionDataState = {
        ...start,
        console: start.console.slice(),
        network: start.network.slice(),
        history: start.history.slice(),
        networkIndex: { ...start.networkIndex },
        batching: true,
      };
      let state = draft;
      // Tallied alongside, then applied once: a replay arrives in chunks of
      // hundreds and copying the record per event is the thing this whole
      // function exists to avoid.
      const tally: Record<string, number> = { ...start.eventsByTab };
      for (const { seq, event, tabId } of events) {
        if (tabId) tally[tabId] = (tally[tabId] ?? 0) + 1;
        const next = applyEvent(state, seq, event, tabId);
        if (next) state = { ...state, ...next };
      }
      state = { ...state, eventsByTab: tally };
      // Trim once, then hand the arrays over.
      const console_ = state.console.length > MAX_CONSOLE ? state.console.slice(-MAX_CONSOLE) : state.console;
      const dropped = Math.max(0, state.network.length - MAX_NETWORK);
      const network = dropped ? state.network.slice(dropped) : state.network;
      const history = state.history.length > MAX_HISTORY ? state.history.slice(-MAX_HISTORY) : state.history;
      set({
        ...state,
        batching: false,
        console: console_,
        network,
        history,
        networkIndex: reindex(network),
        historyLoaded: done || state.historyLoaded,
      });
    },

    pushLocal: (entry, tabId) => {
      const list = [...get().console, { ...entry, seq: localSeq++, ...(tabId ? { tabId } : {}) } as ConsoleEntry];
      set({ console: list.length > MAX_CONSOLE ? list.slice(-MAX_CONSOLE) : list });
    },
  }));
}

function applyEvent(state: SessionDataState, seq: number, event: AgentEvent, tabId?: string): Partial<SessionDataState> | null {
  if (!state.networkRecording && event.type.startsWith('network.')) return null;
  switch (event.type) {
    case 'console.message':
    case 'console.clear':
    case 'error.uncaught':
    case 'error.unhandledrejection': {
      const entry = { ...event, seq, tabId } as ConsoleEntry;
      // console.clear() belongs to the window that called it; Chrome clears that
      // page's console, not every page in the run.
      const cleared = event.type === 'console.clear';
      if (state.batching && !cleared) {
        // The array is private to this replay; trimming happens once at the end.
        state.console.push(entry);
        return { issues: bump(state.issues, entry) };
      }
      const list = cleared
        ? [...state.console.filter((e) => tabId !== undefined && entryTab(e) !== undefined && entryTab(e) !== tabId), entry]
        : [...state.console, entry];
      const issues = cleared ? countIssues(list) : bump(state.issues, entry);
      return { console: list.length > MAX_CONSOLE ? list.slice(-MAX_CONSOLE) : list, issues };
    }

    case 'network.request': {
      const entry: NetworkEntry = { requestId: event.requestId, seq, tabId, request: event };
      if (state.batching) {
        state.network.push(entry);
        state.networkIndex[event.requestId] = state.network.length - 1;
        return null;
      }
      const network = [...state.network, entry];
      const dropped = Math.max(0, network.length - MAX_NETWORK);
      const kept = dropped ? network.slice(dropped) : network;
      return { network: kept, networkIndex: reindex(kept) };
    }

    case 'network.response':
    case 'network.finished':
    case 'network.failed': {
      const idx = state.networkIndex[event.requestId];
      if (idx === undefined) return null;
      const current = state.network[idx]!;
      const key = event.type.slice('network.'.length) as 'response' | 'finished' | 'failed';
      const network = state.batching ? state.network : state.network.slice();
      network[idx] = { ...current, [key]: event };

      // Mirror Chrome: a failed or 4xx/5xx request also shows up in the Console.
      const failed = event.type === 'network.failed';
      const bad = event.type === 'network.response' && event.status >= 400;
      if (failed || bad) {
        const row: ConsoleEntry = {
          type: 'network.error',
          seq: seq + 0.5,
          ts: event.ts,
          ...(current.tabId ? { tabId: current.tabId } : {}),
          requestId: event.requestId,
          method: current.request.method,
          url: current.request.url,
          ...(event.type === 'network.response' ? { status: event.status, statusText: event.statusText } : { error: event.error }),
        };
        const list = [...state.console, row];
        return { network, console: list.length > MAX_CONSOLE ? list.slice(-MAX_CONSOLE) : list, issues: bump(state.issues, row) };
      }
      return { network };
    }

    case 'network.wsFrame': {
      const idx = state.networkIndex[event.requestId];
      if (idx === undefined) return null;
      const current = state.network[idx]!;
      const frames = [...(current.frames ?? []), event];
      const network = state.network.slice();
      network[idx] = { ...current, frames: frames.length > MAX_FRAMES ? frames.slice(-MAX_FRAMES) : frames };
      return { network };
    }

    case 'network.wsClosed': {
      const idx = state.networkIndex[event.requestId];
      if (idx === undefined) return null;
      const network = state.network.slice();
      network[idx] = { ...state.network[idx]!, closed: event };
      return { network };
    }

    case 'page.timing': {
      const next: PageTiming = {
        ...(tabId ? (state.pageTimingByTab[tabId] ?? {}) : state.pageTiming),
        navigationStart: event.navigationStart,
        ...(event.domContentLoaded ? { domContentLoaded: event.domContentLoaded } : {}),
        ...(event.load ? { load: event.load } : {}),
      };
      return { pageTiming: next, ...(tabId ? { pageTimingByTab: { ...state.pageTimingByTab, [tabId]: next } } : {}) };
    }

    case 'network.resourceFailed': {
      // Mark the matching resource row as failed (latest with that URL); remember the URL if the row is still to come.
      const failed = { type: 'network.failed' as const, ts: event.ts, requestId: '', error: `Failed to load resource (${event.tag})` };
      for (let i = state.network.length - 1; i >= 0; i--) {
        const e = state.network[i]!;
        if (e.resource && e.request.url === event.url && !e.failed) {
          const network = state.network.slice();
          network[i] = { ...e, failed: { ...failed, requestId: e.requestId } };
          return { network, console: appendConsole(state.console, resourceErrorRow(seq, event.ts, e.requestId, event.url, e.tabId)) };
        }
      }
      return { pendingResourceFailures: [...state.pendingResourceFailures, event.url] };
    }

    case 'network.resource': {
      const pendingIdx = state.pendingResourceFailures.indexOf(event.entry.name);
      const entry: NetworkEntry = {
        requestId: `res-${seq}`,
        seq,
        tabId,
        resource: event.entry,
        ...(pendingIdx >= 0
          ? { failed: { type: 'network.failed' as const, ts: event.ts, requestId: `res-${seq}`, error: 'Failed to load resource' } }
          : {}),
        request: {
          type: 'network.request',
          ts: event.entry.startedAt ?? event.ts,
          requestId: `res-${seq}`,
          kind: 'resource',
          method: 'GET',
          url: event.entry.name,
          headers: {},
          initiator: event.entry.initiatorType,
        },
      };
      if (state.batching && pendingIdx < 0) {
        state.network.push(entry);
        state.networkIndex[entry.requestId] = state.network.length - 1;
        return null;
      }
      const network = [...state.network, entry];
      if (pendingIdx >= 0) {
        return {
          network,
          networkIndex: reindex(network),
          pendingResourceFailures: state.pendingResourceFailures.filter((_, i) => i !== pendingIdx),
          console: appendConsole(state.console, resourceErrorRow(seq, event.ts, entry.requestId, event.entry.name, tabId)),
        };
      }
      return { network, networkIndex: reindex(network) };
    }

    case 'interaction.click':
    case 'interaction.input':
    case 'interaction.key':
    case 'interaction.scroll':
    case 'interaction.submit':
    case 'perf.longtask':
    case 'perf.layoutShift':
    case 'perf.paint':
    case 'dom.activity':
    case 'mark.custom':
    case 'page.title':
      return { history: appendHistory(state.history, { ...event, seq, tabId }, state.batching) };

    case 'page.navigated': {
      // Older recordings have no `kind`; treat them as in-page navigations.
      if (event.kind !== 'load') {
        // in-page (pushState/popstate): a history marker only
        return { history: appendHistory(state.history, { ...event, seq, tabId }, state.batching) };
      }
      const row = { ...event, seq, tabId } as ConsoleEntry;
      const history = appendHistory(state.history, { ...event, seq, tabId }, state.batching);
      // A failure waiting for a row that never came must not attach itself to
      // the same URL after the next load.
      const clearedTiming = {
        pendingResourceFailures: [],
        ...(tabId ? { pageTiming: {}, pageTimingByTab: { ...state.pageTimingByTab, [tabId]: {} } } : { pageTiming: {} }),
      };
      if (state.preserveLog) return { console: [...state.console, row], history, ...clearedTiming };
      // A load clears the window that reloaded, not the other windows of the session.
      const keptConsole = state.console.filter((e) => entryTab(e) !== undefined && entryTab(e) !== tabId);
      const keptNetwork = state.network.filter((e) => e.tabId !== undefined && e.tabId !== tabId);
      const nextConsole = [...keptConsole, row];
      // Recount: the badge totals are kept as entries arrive, so dropping this
      // window's entries has to drop their errors and warnings with them.
      return { console: nextConsole, network: keptNetwork, networkIndex: reindex(keptNetwork), history, issues: countIssues(nextConsole), ...clearedTiming };
    }
    case 'page.visibility':
      return null;
  }
}

/** The window an entry came from, for entries that carry one. */
export function entryTab(e: ConsoleEntry): string | undefined {
  return (e as { tabId?: string }).tabId;
}

function appendHistory(list: HistoryEntry[], entry: HistoryEntry, batching = false): HistoryEntry[] {
  if (batching) {
    list.push(entry);
    return list;
  }
  const next = [...list, entry];
  return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
}

/** Totals for the badge, kept as entries arrive instead of rescanning. */
function bump(issues: { errors: number; warnings: number }, entry: ConsoleEntry): { errors: number; warnings: number } {
  const sev = severityOf(entry);
  if (sev === 'error' && entry.type !== 'eval.result') return { ...issues, errors: issues.errors + 1 };
  if (sev === 'warning') return { ...issues, warnings: issues.warnings + 1 };
  return issues;
}

function countIssues(list: ConsoleEntry[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const e of list) {
    const sev = severityOf(e);
    if (sev === 'error' && e.type !== 'eval.result') errors++;
    else if (sev === 'warning') warnings++;
  }
  return { errors, warnings };
}

function appendConsole(list: ConsoleEntry[], row: ConsoleEntry): ConsoleEntry[] {
  const next = [...list, row];
  return next.length > MAX_CONSOLE ? next.slice(-MAX_CONSOLE) : next;
}

function resourceErrorRow(seq: number, ts: number, requestId: string, url: string, tabId?: string): ConsoleEntry {
  return { type: 'network.error', seq: seq + 0.5, ts, ...(tabId ? { tabId } : {}), requestId, method: 'GET', url, error: 'Failed to load resource' };
}

function reindex(list: NetworkEntry[]): Record<string, number> {
  const idx: Record<string, number> = {};
  list.forEach((e, i) => {
    idx[e.requestId] = i;
  });
  return idx;
}
