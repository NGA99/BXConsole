/**
 * In-memory view of all sessions, live and historical.
 *
 * A session row exists as soon as an agent says hello and stays after it
 * disconnects (connected: false) so the Sessions tab can still open its
 * recorded history. Rows are rebuilt from sessions/ on startup.
 */
import type { WebSocket } from 'ws';
import type { SessionHello, SessionMeta, SessionTab } from '@bxconsole/protocol';
import type { SessionStore } from './store';
import { usableTabPatch } from './tab-patch';

export interface SessionEntry {
  meta: SessionMeta;
  /** one live agent per window in this session, keyed by tabId */
  agents: Map<string, WebSocket>;
  /** the window commands go to when the console does not name one */
  activeTabId: string | null;
  subscribers: Set<WebSocket>;
  /**
   * Consoles with the Screen tab open, and which window each is watching.
   * A window streams while at least one console is on it, so two consoles can
   * watch two different windows of the same session at the same time.
   */
  screenSubscribers: Map<WebSocket, string | undefined>;
  /** next event sequence number; continues from disk after restart */
  seq: number;
}

/** The agent for a given window, or the session's active one when none is named. */
export function agentFor(entry: SessionEntry, tabId?: string): WebSocket | null {
  if (tabId) return entry.agents.get(tabId) ?? null;
  if (entry.activeTabId) {
    const active = entry.agents.get(entry.activeTabId);
    if (active) return active;
  }
  for (const ws of entry.agents.values()) return ws;
  return null;
}

type Listener = (entry: SessionEntry) => void;

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly store: SessionStore) {}

  async loadFromDisk(): Promise<void> {
    for (const { meta, lastSeq } of await this.store.listSessions()) {
      // Older meta.json files carry stray hello fields; drop them on the way in.
      const { tabId: _t, tabStartedAt: _ts, openedBy: _o, ...clean } = meta as SessionMeta & { tabId?: string; tabStartedAt?: number; openedBy?: string };
      this.sessions.set(meta.sessionId, {
        meta: { ...clean, connected: false, tabs: (meta.tabs ?? []).map((t) => ({ ...t, connected: false })) },
        agents: new Map(),
        activeTabId: null,
        subscribers: new Set(),
        screenSubscribers: new Map(),
        seq: lastSeq + 1,
      });
    }
  }

  all(): SessionMeta[] {
    return Array.from(this.sessions.values(), (e) => e.meta).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * An agent connected: a new window of this session, or an existing window
   * after a reload. The session row survives either way; only the tab changes.
   */
  async upsertFromHello(
    hello: SessionHello,
    agent: WebSocket,
    /**
     * Which project this run belongs in, decided by the relay from the key
     * in the payload — never read out of the hello. The page knows which
     * session it is, which is a different question, and a page that could
     * name a project could drop its recording into somebody else's
     * engagement. Undefined only on a relay with no project list.
     */
    projectId?: string,
  ): Promise<{ entry: SessionEntry; tabId: string }> {
    const now = Date.now();
    // Two live windows can arrive claiming the same id: duplicating a tab copies
    // sessionStorage without giving the copy an opener, so the collision rule in
    // the page has nothing to compare against. Letting the second one through as
    // "a reload" would close the first, which reconnects and closes the second,
    // forever. The relay is the authority here: a claim on an id that is still
    // live gets a fresh one, which the agent adopts from the ack.
    const existing = this.sessions.get(hello.sessionId);
    const held = existing?.agents.get(hello.tabId);
    const tabId = held && held.readyState === held.OPEN ? freshTabId() : hello.tabId;

    const tab: SessionTab = {
      tabId,
      url: hello.url,
      title: hello.title,
      viewport: hello.viewport,
      ...(hello.openedBy ? { openedBy: hello.openedBy } : {}),
      startedAt: hello.tabStartedAt ?? hello.startedAt,
      lastSeenAt: now,
      connected: true,
    };

    let entry = existing;
    if (!entry) {
      const { tabId: _tab, tabStartedAt: _tabStart, openedBy: _opener, key: _key, ...base } = hello;
      entry = {
        meta: { ...base, ...(projectId ? { projectId } : {}), lastSeenAt: now, connected: true, tabs: [tab] },
        agents: new Map(),
        activeTabId: null,
        subscribers: new Set(),
        screenSubscribers: new Map(),
        seq: 1,
      };
      this.sessions.set(hello.sessionId, entry);
    } else {
      // A reload of the same window supersedes its old socket, not the session.
      if (tabId === hello.tabId) entry.agents.get(tabId)?.close();
      const tabs = entry.meta.tabs.slice();
      const i = tabs.findIndex((t) => t.tabId === tabId);
      if (i >= 0) tabs[i] = { ...tabs[i]!, ...tab, startedAt: tabs[i]!.startedAt };
      else tabs.push(tab);
      // A page talking again means the run is in use: take it out of the trash.
      const { trashedAt: _trashed, ...kept } = entry.meta;
      // A recording from before projects, or one the migration did not
      // reach, gets the project written down now that it is talking again.
      // It was already being read as being in this one, and a run that has
      // a project keeps it: see the relay's landingFor.
      const landed = kept.projectId ?? projectId;
      entry.meta = {
        ...kept,
        ...(landed ? { projectId: landed } : {}),
        url: hello.url,
        title: hello.title,
        name: hello.name ?? entry.meta.name,
        lastSeenAt: now,
        connected: true,
        tabs,
      };
    }

    entry.agents.set(tabId, agent);
    entry.activeTabId = tabId;
    await this.store.writeMeta(entry.meta);
    this.emit(entry);
    return { entry, tabId };
  }

  /** One window went away. The session stays connected while any other one is live. */
  async markTabDisconnected(sessionId: string, tabId: string, agent: WebSocket): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.agents.get(tabId) !== agent) return; // superseded by a reload
    entry.agents.delete(tabId);
    if (entry.activeTabId === tabId) entry.activeTabId = entry.agents.keys().next().value ?? null;
    const tabs = entry.meta.tabs.map((t) => (t.tabId === tabId ? { ...t, connected: false, lastSeenAt: Date.now() } : t));
    entry.meta = { ...entry.meta, tabs, connected: entry.agents.size > 0, lastSeenAt: Date.now() };
    await this.store.writeMeta(entry.meta);
    this.emit(entry);
  }

  /**
   * Move a run to the trash, or take it back out.
   *
   * Nothing is deleted here: the recording stays on disk and the row moves to
   * the Trash view, so the irreversible step is a separate, deliberate one.
   */
  async setTrashed(sessionId: string, trashed: boolean): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (trashed) entry.meta = { ...entry.meta, trashedAt: Date.now() };
    else {
      const { trashedAt: _gone, ...rest } = entry.meta;
      entry.meta = rest;
    }
    await this.store.writeMeta(entry.meta);
    this.emit(entry);
    return true;
  }

  /** Keep a tab's url/title current as the window navigates. */
  async updateTab(sessionId: string, tabId: string, patch: Partial<SessionTab>): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // Everything that reaches here came out of a page's own event, so it is
    // checked before it can become part of what is on disk.
    const safe = usableTabPatch(patch);
    const tabs = entry.meta.tabs.map((t) => (t.tabId === tabId ? { ...t, ...safe, lastSeenAt: Date.now() } : t));
    const active = tabs.find((t) => t.tabId === tabId);
    entry.meta = { ...entry.meta, tabs, lastSeenAt: Date.now(), ...(active ? { url: active.url, title: active.title } : {}) };
    await this.store.writeMeta(entry.meta);
    this.emit(entry);
  }

  async updateMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.meta = { ...entry.meta, ...patch, lastSeenAt: Date.now() };
    await this.store.writeMeta(entry.meta);
    this.emit(entry);
  }

  async forget(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    for (const ws of entry.agents.values()) ws.close();
    this.sessions.delete(sessionId);
    await this.store.remove(sessionId);
    // Its files were shared, so the bytes go only once nothing else wants
    // them. Not awaited: the sweep walks every session, and deleting a
    // recording should not wait on it.
    void this.onRemoved?.(sessionId);
    return true;
  }

  /** Called after a session's directory is gone, for whatever shares its files. */
  onRemoved: ((sessionId: string) => void | Promise<void>) | null = null;

  nextSeq(entry: SessionEntry): number {
    return entry.seq++;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(entry: SessionEntry): void {
    for (const l of this.listeners) l(entry);
  }
}

function freshTabId(): string {
  return `t${Math.random().toString(36).slice(2, 10)}`;
}
