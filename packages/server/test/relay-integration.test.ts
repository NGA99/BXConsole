/**
 * The relay with agents and consoles attached, which is the layer where the
 * pieces meet and where nothing was covered.
 *
 * The invariants here are the ones that are invisible until a recording is
 * read back weeks later: that what a console is shown and what goes to disk
 * are allowed to differ but must say the same thing; that two windows of one
 * run stay one run; and that a page reconnecting does not take the recording
 * with it.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { SESSION_FILES, sessionDirName, PROTOCOL_VERSION } from '@bxconsole/protocol';
import type { ConsoleToServer, Project, SessionMeta } from '@bxconsole/protocol';
import type { Account } from '../src/passwd';
import { SessionStore } from '../src/store';
import { SessionRegistry } from '../src/registry';
import { BlobStore } from '../src/blobs';
import { Relay } from '../src/relay';
import { ProjectStore } from '../src/projects';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-relay-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Just enough of a socket for the relay: it sends, it receives, it closes. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly handlers = new Map<string, Array<(arg: unknown) => void>>();

  on(event: string, fn: (arg: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    for (const fn of this.handlers.get('close') ?? []) fn(undefined);
  }
  /** Deliver a message as the page would, and let the relay get to work on it. */
  async deliver(msg: unknown): Promise<void> {
    for (const fn of this.handlers.get('message') ?? []) fn(JSON.stringify(msg));
    await settle();
  }
  received(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

/**
 * Let the relay's own promise chains run out.
 *
 * The relay answers a message through several awaits — a meta write, an
 * append chain, sometimes a blob write — and none of them is observable from
 * here. Waiting a fixed number of milliseconds made these tests fail on a
 * loaded machine and pass on an idle one, which is worse than not having
 * them; `until` waits for the thing the test is actually about.
 */
const settle = () => new Promise((r) => setTimeout(r, 5));

async function until<T>(get: () => T | Promise<T>, what: string, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await get();
    if (got) return got as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The recorded lines of a file, once there are as many as the test expects. */
const recorded = (sessionId: string, file: keyof typeof SESSION_FILES, count = 1) =>
  until(async () => {
    const lines = await linesOf(sessionId, file);
    return lines.length >= count ? lines : undefined;
  }, `${count} line(s) in ${file}.ndjson`);

function build(budget = Number.POSITIVE_INFINITY) {
  const store = new SessionStore(dir);
  const registry = new SessionRegistry(store);
  const relay = new Relay(registry, store);
  const blobs = new BlobStore(dir, budget);
  relay.useBlobs(blobs);
  return { store, registry, relay, blobs };
}

/**
 * Attach a window and wait for its acknowledgement before sending anything.
 *
 * This is what the real agent does — transport.ts holds every event until
 * `session.ack` arrives and only then flushes — and it matters: the relay
 * drops events that arrive before the hello has been processed, so a test
 * that fires straight after the hello is racing a write it cannot see.
 */
async function join(relay: Relay, over: Record<string, unknown> = {}): Promise<FakeSocket> {
  const agent = new FakeSocket();
  relay.attachAgent(agent as unknown as WebSocket);
  await agent.deliver(hello(over));
  await until(() => agent.received('session.ack')[0], 'the hello to be acknowledged');
  return agent;
}

const hello = (over: Record<string, unknown> = {}) => ({
  type: 'session.hello',
  // The relay says so in the log when this is missing or different, which is
  // the point of it; a test that does not mean to say that sends the real one.
  v: PROTOCOL_VERSION,
  hello: {
    sessionId: 'sess01',
    tabId: 'tabA',
    tabStartedAt: 1000,
    name: 'run',
    url: 'http://app.test/',
    title: 'app',
    userAgent: 'test',
    viewport: { width: 800, height: 600, dpr: 1 },
    startedAt: 1000,
    ...over,
  },
});

const response = (body: string, over: Record<string, unknown> = {}) => ({
  type: 'network.response',
  ts: 2,
  requestId: 'r1',
  status: 200,
  statusText: 'OK',
  headers: {},
  mimeType: 'application/json',
  body,
  ...over,
});

async function linesOf(sessionId: string, file: keyof typeof SESSION_FILES): Promise<Array<Record<string, any>>> {
  try {
    const text = await fs.readFile(path.join(dir, sessionDirName(sessionId), SESSION_FILES[file]), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('a page joining a run', () => {
  test('a hello is acknowledged with the ids the relay actually used', async () => {
    const { relay } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    await agent.deliver(hello());
    const ack = await until(() => agent.received('session.ack')[0], 'the hello to be acknowledged');
    assert.equal(ack.sessionId, 'sess01');
    assert.equal(ack.tabId, 'tabA');
  });

  test('two live windows claiming one id do not fight over it forever', async () => {
    // Duplicating a tab copies sessionStorage without giving the copy an
    // opener, so both pages believe they are the same window. Letting the
    // second in as "a reload" closes the first, which reconnects and closes
    // the second, and so on.
    const { relay } = build();
    const first = new FakeSocket();
    const second = new FakeSocket();
    relay.attachAgent(first as unknown as WebSocket);
    relay.attachAgent(second as unknown as WebSocket);
    await first.deliver(hello());
    await second.deliver(hello());
    const a = await until(() => first.received('session.ack')[0], 'the first ack');
    const b = await until(() => second.received('session.ack')[0], 'the second ack');
    assert.equal(a.sessionId, b.sessionId, 'both are the same run');
    assert.notEqual(a.tabId, b.tabId, 'but not the same window');
    assert.equal(first.readyState, first.OPEN, 'the first window must not have been closed');
  });

  test('a reload of one window supersedes that window, not the run', async () => {
    const { relay, registry } = build();
    const before = new FakeSocket();
    relay.attachAgent(before as unknown as WebSocket);
    await before.deliver(hello());
    before.close();
    await settle();

    const after = new FakeSocket();
    relay.attachAgent(after as unknown as WebSocket);
    await after.deliver(hello());
    const meta = registry.get('sess01')!.meta;
    assert.equal(meta.connected, true);
    assert.equal(meta.tabs.length, 1, 'a reload is the same window, not a new one');
  });

  test('events before a hello are dropped rather than written somewhere', async () => {
    const { relay } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    await agent.deliver(response('{"early":true}'));
    assert.deepEqual(await linesOf('sess01', 'network'), []);
  });

  test('a hello naming a path for a session id is refused', async () => {
    const { relay, registry } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    await agent.deliver(hello({ sessionId: '../../etc/passwd' }));
    assert.equal(agent.received('session.ack').length, 0);
    assert.equal(registry.all().length, 0);
  });

  test('a malformed message does not take the connection down', async () => {
    const { relay, registry } = build();
    const agent = new FakeSocket();
    relay.attachAgent(agent as unknown as WebSocket);
    for (const junk of ['not json', '[]', '{"type":42}', 'null']) {
      for (const fn of (agent as any).handlers.get('message') ?? []) fn(junk);
    }
    await settle();
    await agent.deliver(hello());
    assert.equal(registry.all().length, 1, 'the socket still works afterwards');
  });
});

describe('what the console sees and what the disk keeps', () => {
  test('a live console gets the body; the recording keeps a reference to it', async () => {
    const { relay, registry } = build();
    const agent = await join(relay);
    const console_ = new FakeSocket();
    relay.attachConsole(console_ as unknown as WebSocket);
    registry.get('sess01')!.subscribers.add(console_ as unknown as WebSocket);

    const big = JSON.stringify({ rows: 'x'.repeat(5000) });
    await agent.deliver(response(big));

    const forwarded = await until(() => console_.received('session.event')[0]?.event as Record<string, unknown>, 'the event to reach the console');
    assert.equal(forwarded.body, big, 'the console already has the bytes; it must not be made to fetch them');
    assert.equal(forwarded.bodyRef, undefined);

    const [line] = await recorded('sess01', 'network');
    assert.equal(line!.event.body, undefined, 'the recording should not carry it inline');
    assert.match(String(line!.event.bodyRef), /^[0-9a-f]{64}$/);
    assert.equal(line!.event.bodyBytes, Buffer.byteLength(big));
  });

  test('a small body is left where it is, and is still there to read', async () => {
    const { relay } = build();
    const agent = await join(relay);
    await agent.deliver(response('{"ok":1}'));
    const [line] = await recorded('sess01', 'network');
    assert.equal(line!.event.body, '{"ok":1}');
    assert.equal(line!.event.bodyRef, undefined);
  });

  test('the bytes behind a reference come back byte for byte, non-ASCII included', async () => {
    const { relay, blobs } = build();
    const agent = await join(relay);
    const body = JSON.stringify({ note: 'çafé — naïve ☕ '.repeat(400) });
    await agent.deliver(response(body));
    const [line] = await recorded('sess01', 'network');
    await blobs.whenQuiet('sess01');
    const held = await blobs.read(String(line!.event.bodyRef));
    assert.equal(held?.toString('utf8'), body);
  });

  test('a body the store refuses is dropped, with its size kept', async () => {
    /*
     * This used to assert the opposite — a refused body stayed in the line,
     * so that a recording never came out with less in it than went in. The
     * rule is right and that was the wrong place for it: the store refuses a
     * body for being over 4 MiB or for taking the run past its 50 MB budget,
     * and sending those to network.ndjson instead meant the budget bounded
     * nothing. Past it every body went into a file with no ceiling and no
     * compaction, which is read end to end whenever the session is opened —
     * so an ordinary long run grew without limit and a socket forging its own
     * events could fill a disk on purpose.
     */
    const { relay, blobs } = build(10); // a budget nothing will fit in
    const agent = await join(relay);
    const big = 'y'.repeat(5000);
    await agent.deliver(response(big));
    const [line] = await recorded('sess01', 'network');
    await blobs.whenQuiet('sess01');
    assert.equal(line!.event.body, undefined, 'the refused body is still taking up the event log');
    assert.equal(line!.event.bodyRef, undefined, 'nothing was stored, so there is nothing to point at');
    assert.equal(line!.event.bodyDropped, true, 'the reader cannot tell a dropped body from one nobody captured');
    assert.equal(line!.event.bodyBytes, 5000, 'the size is the one thing left worth keeping');
  });

  test('a body small enough to store is untouched by any of that', async () => {
    const { relay, blobs } = build();
    const agent = await join(relay);
    const body = 'z'.repeat(5000);
    await agent.deliver(response(body));
    const [line] = await recorded('sess01', 'network');
    await blobs.whenQuiet('sess01');
    assert.equal(line!.event.bodyDropped, undefined);
    assert.ok(line!.event.bodyRef, 'it should have gone to the store');
    assert.equal((await blobs.read(String(line!.event.bodyRef)))?.toString('utf8'), body);
  });

  test('events stay in seq order even though some of them wait on a blob write', async () => {
    const { relay } = build();
    const agent = await join(relay);
    // Alternate expensive and cheap, which is what a real page does.
    for (let i = 0; i < 8; i++) {
      await agent.deliver(response(i % 2 ? '{"small":1}' : JSON.stringify({ big: String(i).repeat(3000) }), { requestId: `r${i}` }));
    }
    const seqs = (await recorded('sess01', 'network', 8)).map((l) => l.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `out of order: ${seqs}`);
    assert.equal(seqs.length, 8, 'nothing was dropped on the way');
  });
});

describe('a run spanning several windows', () => {
  test('a second window joins the run rather than starting one', async () => {
    const { relay, registry } = build();
    await join(relay);
    await join(relay, { tabId: 'tabB', openedBy: 'tabA' });
    assert.equal(registry.all().length, 1);
    const meta = registry.get('sess01')!.meta;
    assert.deepEqual(meta.tabs.map((t) => t.tabId).sort(), ['tabA', 'tabB']);
    assert.equal(meta.tabs.find((t) => t.tabId === 'tabB')?.openedBy, 'tabA');
  });

  test('one window closing leaves the run connected while another is live', async () => {
    const { relay, registry } = build();
    const a = await join(relay);
    const b = await join(relay, { tabId: 'tabB' });
    a.close();
    // Waiting a fixed few milliseconds for the registry to catch up made this
    // pass alone and fail in a full run; the disconnect is written through an
    // async chain that nothing here can see finish.
    await until(() => registry.get('sess01')!.meta.tabs.every((t) => t.tabId !== 'tabA' || !t.connected), 'the first window to be marked gone');
    assert.equal(registry.get('sess01')!.meta.connected, true, 'the run is still live while another window is');
    b.close();
    await until(() => !registry.get('sess01')!.meta.connected, 'the run to be marked offline');
    assert.equal(registry.get('sess01')!.meta.connected, false);
  });

  test('events carry the window they came from, so the tab strip can split them', async () => {
    const { relay } = build();
    const a = await join(relay);
    const b = await join(relay, { tabId: 'tabB' });
    await a.deliver(response('{"from":"a"}', { requestId: 'ra' }));
    await b.deliver(response('{"from":"b"}', { requestId: 'rb' }));
    const byTab = Object.fromEntries((await recorded('sess01', 'network', 2)).map((l) => [l.event.requestId, l.tabId]));
    assert.deepEqual(byTab, { ra: 'tabA', rb: 'tabB' });
  });
});

describe('the collection choice', () => {
  test('it is the run’s, taken from the window that started it', async () => {
    const { relay, registry } = build();
    const a = new FakeSocket();
    relay.attachAgent(a as unknown as WebSocket);
    await a.deliver(hello({ collect: false }));
    const b = new FakeSocket();
    relay.attachAgent(b as unknown as WebSocket);
    await b.deliver(hello({ tabId: 'tabB', collect: true }));
    assert.equal(registry.get('sess01')!.meta.collect, false, 'a later window must not flip the run’s choice');
  });

  test('a recording from before the option existed is treated as collecting', async () => {
    const { registry } = build();
    assert.equal(registry.get('sess01'), undefined);
    // `collect` absent, as every hello sent before the flag existed.
    const { relay, registry: reg2 } = build();
    const a = new FakeSocket();
    relay.attachAgent(a as unknown as WebSocket);
    await a.deliver(hello());
    assert.equal(reg2.get('sess01')!.meta.collect, undefined, 'absent, which the relay reads as on');
  });
});

/*
 * What one console is allowed to see.
 *
 * The relay decides this in one place — `visibleTo(actor)` — and the gate at
 * the top of the console handler turns that into "this message names a
 * session you cannot see, so there is no answer". Today visibleTo says yes to
 * everything, because sessions are not divided by anything yet; projects come
 * next. These tests subclass it to say what it will say then, so the wiring
 * that carries the answer is covered before the answer is real, and so they
 * keep meaning the same thing once it is.
 */
describe('what one console may see', () => {
  const ana: Account = { user: 'ana', record: 'x', id: 'a1a1a1', role: 'member' };
  const bo: Account = { user: 'bo', record: 'x', id: 'b2b2b2', role: 'member' };
  const root: Account = { user: 'root', record: 'x', id: 'c3c3c3', role: 'admin' };

  /**
   * A relay with two real projects: ana's, which the live run is in, and
   * bo's, which is empty.
   *
   * These were written against a subclass that stubbed `visibleTo`, because
   * there were no projects for it to answer from yet. There are now, so the
   * stub is gone and the same tests run against the thing itself.
   */
  async function scoped() {
    const store = new SessionStore(dir);
    const registry = new SessionRegistry(store);
    const relay = new Relay(registry, store);
    relay.useBlobs(new BlobStore(dir, Number.POSITIVE_INFINITY));
    const projects = new ProjectStore(dir);
    await projects.load();
    // Ana's is first, so it is the home one and the run that says hello lands
    // in it — which is what the relay does until a payload carries a key.
    const hers = await projects.create('Ana’s', ana.id);
    const his = await projects.create('Bo’s', bo.id);
    relay.useProjects(projects);
    relay.useAccountIds(() => new Set([ana.id, bo.id, root.id]));
    registry.useProjectSource(() => projects.homeId() ?? undefined);
    const agent = await join(relay);
    return { relay, agent, projects, hers, his, registry };
  }

  test('the snapshot at sign-in holds only the sessions that account may see', async () => {
    const { relay } = await scoped();
    const hers = new FakeSocket();
    const his = new FakeSocket();
    relay.attachConsole(hers as unknown as WebSocket, ana);
    relay.attachConsole(his as unknown as WebSocket, bo);

    const toAna = hers.received('sessions.snapshot')[0]!['sessions'] as SessionMeta[];
    const toBo = his.received('sessions.snapshot')[0]!['sessions'] as SessionMeta[];
    assert.deepEqual(toAna.map((m) => m.sessionId), ['sess01']);
    assert.deepEqual(toBo.map((m) => m.sessionId), [], 'bo must not be told the session exists');
  });

  test('asking for the list again is answered the same way, not from the registry', async () => {
    // sessions.list went straight to registry.all() and so handed back every
    // session to anyone who asked for a refresh.
    const { relay } = await scoped();
    const his = new FakeSocket();
    relay.attachConsole(his as unknown as WebSocket, bo);
    await his.deliver({ type: 'sessions.list' });
    for (const snap of his.received('sessions.snapshot')) {
      assert.deepEqual((snap['sessions'] as SessionMeta[]).map((m) => m.sessionId), []);
    }
  });

  test('a message naming a session that account cannot see gets no answer at all', async () => {
    const { relay, agent } = await scoped();
    const his = new FakeSocket();
    relay.attachConsole(his as unknown as WebSocket, bo);
    const sentToHim = his.sent.length;
    const sentToAgent = agent.sent.length;
    /*
     * Typed as the union on purpose. The first version of this sent
     * `session.remove`, which is not a message the relay has, so every one of
     * them fell through to the default case and the test proved nothing.
     */
    const asking: ConsoleToServer[] = [
      { type: 'session.subscribe', sessionId: 'sess01', replay: true },
      { type: 'eval.request', sessionId: 'sess01', tabId: 'tabA', commandId: 'c1', expression: 'document.cookie' },
      { type: 'sources.list', sessionId: 'sess01', tabId: 'tabA', requestId: 'q1' },
      { type: 'screen.subscribe', sessionId: 'sess01', tabId: 'tabA' },
      { type: 'files.list', sessionId: 'sess01' },
      { type: 'network.configure', sessionId: 'sess01', blocked: ['*'] },
    ];
    for (const msg of asking) await his.deliver(msg);
    await settle();

    // Not even an error: a refusal that names the session confirms it is there.
    assert.equal(his.sent.length, sentToHim, `answered with ${JSON.stringify(his.sent.slice(sentToHim))}`);
    // And nothing reached the page, which is the part that matters most —
    // eval.request on someone else's run is their victim's browser.
    assert.equal(agent.sent.length, sentToAgent, `sent to the page: ${JSON.stringify(agent.sent.slice(sentToAgent))}`);
  });

  test('a session it cannot see cannot be trashed or deleted by it', async () => {
    const { relay } = await scoped();
    const his = new FakeSocket();
    relay.attachConsole(his as unknown as WebSocket, bo);
    const destructive: ConsoleToServer[] = [
      { type: 'session.trash', sessionId: 'sess01' },
      { type: 'session.forget', sessionId: 'sess01' },
    ];

    for (const msg of destructive) await his.deliver(msg);
    await settle();

    const hers = new FakeSocket();
    relay.attachConsole(hers as unknown as WebSocket, ana);
    const left = hers.received('sessions.snapshot')[0]!['sessions'] as SessionMeta[];
    assert.deepEqual(left.map((m) => m.sessionId), ['sess01'], 'bo deleted a session he cannot see');
    assert.equal(left[0]!.trashedAt, undefined, 'bo trashed a session he cannot see');
  });

  test('a session changing is told only to the consoles that may see it', async () => {
    /*
     * This is the broadcast, not the gate: every meta change used to go to
     * every console connected, so a title change on one account's run pushed
     * that run's url, title and user agent to everybody.
     */
    const { relay } = await scoped();
    const hers = new FakeSocket();
    const his = new FakeSocket();
    relay.attachConsole(hers as unknown as WebSocket, ana);
    relay.attachConsole(his as unknown as WebSocket, bo);

    await hers.deliver({ type: 'session.trash', sessionId: 'sess01' } satisfies ConsoleToServer);
    await until(() => hers.received('session.updated')[0], 'ana to be told her session moved');
    assert.equal(his.received('session.updated').length, 0, 'bo was told about a session he cannot see');

    await hers.deliver({ type: 'session.forget', sessionId: 'sess01' } satisfies ConsoleToServer);
    await until(() => hers.received('session.removed')[0], 'ana to be told it is gone');
    assert.equal(his.received('session.removed').length, 0, 'bo was told a session he cannot see was deleted');
  });

  test('a live event reaches the consoles that may see its session and no others', async () => {
    const { relay, agent } = await scoped();
    const hers = new FakeSocket();
    const his = new FakeSocket();
    relay.attachConsole(hers as unknown as WebSocket, ana);
    relay.attachConsole(his as unknown as WebSocket, bo);
    await hers.deliver({ type: 'session.subscribe', sessionId: 'sess01', replay: false });

    await agent.deliver({ type: 'console.message', ts: 3, level: 'log', args: [{ type: 'string', value: 'hi' }] });
    await until(() => hers.received('session.event')[0], 'ana to get the event');
    assert.equal(his.received('session.event').length, 0);
    // The meta updates that ride alongside it are scoped the same way.
    assert.equal(his.received('session.updated').length, 0, 'bo was told the session changed');
  });
});

describe('projects over the console socket', () => {
  const ana: Account = { user: 'ana', record: 'x', id: 'a1a1a1', role: 'member' };
  const bo: Account = { user: 'bo', record: 'x', id: 'b2b2b2', role: 'member' };
  const root: Account = { user: 'root', record: 'x', id: 'c3c3c3', role: 'admin' };

  /** A relay with a home project of ana's holding one live run. */
  async function withProjects() {
    const store = new SessionStore(dir);
    const registry = new SessionRegistry(store);
    const relay = new Relay(registry, store);
    relay.useBlobs(new BlobStore(dir, Number.POSITIVE_INFINITY));
    const projects = new ProjectStore(dir);
    await projects.load();
    const hers = await projects.create('Ana’s', ana.id);
    relay.useProjects(projects);
    relay.useAccountIds(() => new Set([ana.id, bo.id, root.id]));
    registry.useProjectSource(() => projects.homeId() ?? undefined);
    const agent = await join(relay);
    return { relay, registry, projects, hers, agent };
  }

  /** Attach a console as this account and hand back its socket. */
  function console_(relay: Relay, actor: Account): FakeSocket {
    const ws = new FakeSocket();
    relay.attachConsole(ws as unknown as WebSocket, actor);
    return ws;
  }
  const projectsSeen = (ws: FakeSocket): Project[] =>
    (ws.received('projects.snapshot').at(-1)?.['projects'] as Project[] | undefined) ?? [];

  test('a console is told its projects before the sessions it has to group', async () => {
    const { relay, hers } = await withProjects();
    const hersSocket = console_(relay, ana);
    // Order matters: the sessions are grouped by project, so a list that
    // arrived first would have to be regrouped the moment it was drawn.
    const types = hersSocket.sent.map((m) => m['type']);
    assert.ok(types.indexOf('projects.snapshot') < types.indexOf('sessions.snapshot'), types.join(', '));
    assert.deepEqual(projectsSeen(hersSocket).map((p) => p.id), [hers.id]);
    assert.equal(hersSocket.received('projects.snapshot')[0]!['homeProjectId'], hers.id);
    const hisSocket = console_(relay, bo);
    assert.deepEqual(projectsSeen(hisSocket), [], 'bo owns none of them');
    // Not even which one the home project is: it is where a new run lands,
    // so a console that can see it needs the id and one that cannot would
    // just be holding the id of somebody else's engagement.
    assert.equal(hisSocket.received('projects.snapshot')[0]!['homeProjectId'], '');
  });

  test('a run that says hello lands in the home project', async () => {
    const { registry, hers } = await withProjects();
    assert.equal(registry.get('sess01')?.meta.projectId, hers.id);
  });

  test('a project is made for whoever asked, and nobody else hears about it', async () => {
    const { relay } = await withProjects();
    const hersSocket = console_(relay, ana);
    const hisSocket = console_(relay, bo);
    await hersSocket.deliver({ type: 'project.create', name: '  A new   engagement ' } satisfies ConsoleToServer);

    const made = hersSocket.received('project.updated').at(-1)!['project'] as Project;
    assert.equal(made.name, 'A new engagement');
    assert.equal(made.owner, ana.id);
    assert.equal(hisSocket.received('project.updated').length, 0);

    // And to her other window, not only the socket that asked.
    const herOtherSocket = console_(relay, ana);
    await herOtherSocket.deliver({ type: 'project.create', name: 'From the other window' } satisfies ConsoleToServer);
    await until(() => hersSocket.received('project.updated').length === 2, 'her first window to hear about it');
    assert.equal((hersSocket.received('project.updated').at(-1)!['project'] as Project).name, 'From the other window');
  });

  test('a project nobody shared cannot be read, renamed or deleted by another account', async () => {
    const { relay, hers, projects } = await withProjects();
    const hisSocket = console_(relay, bo);
    const asking: ConsoleToServer[] = [
      { type: 'project.rename', projectId: hers.id, name: 'mine now' },
      { type: 'project.trash', projectId: hers.id },
      { type: 'project.forget', projectId: hers.id },
      { type: 'project.transfer', projectId: hers.id, toAccountId: bo.id },
    ];
    const before = hisSocket.sent.length;
    for (const msg of asking) await hisSocket.deliver(msg);
    await settle();

    assert.equal(hisSocket.sent.length, before, `answered with ${JSON.stringify(hisSocket.sent.slice(before))}`);
    assert.equal(projects.get(hers.id)?.name, 'Ana’s');
    assert.equal(projects.get(hers.id)?.owner, ana.id);
    assert.equal(projects.get(hers.id)?.trashedAt, undefined);
  });

  test('being shared a project is being able to read it, not to delete it', async () => {
    const { relay, registry, hers, projects } = await withProjects();
    /*
     * The second project, not the home one.
     *
     * The first version of this shared the home project, which `remove`
     * refuses outright — so it survived bo's delete for a reason that had
     * nothing to do with who owns it, and the test passed with the ownership
     * check taken out.
     */
    const shared = await projects.create('Shared', ana.id);
    await projects.update(shared.id, { sharedWith: [bo.id] });
    const entry = registry.get('sess01')!;
    entry.meta = { ...entry.meta, projectId: shared.id };

    const hisSocket = console_(relay, bo);
    assert.deepEqual(projectsSeen(hisSocket).map((p) => p.id), [shared.id], 'not ana’s other project');
    // And the run inside it, which is the point of sharing one.
    const sessions = hisSocket.received('sessions.snapshot')[0]!['sessions'] as SessionMeta[];
    assert.deepEqual(sessions.map((m) => m.sessionId), ['sess01']);

    for (const msg of [
      { type: 'project.forget', projectId: shared.id },
      { type: 'project.rename', projectId: shared.id, name: 'mine now' },
      { type: 'project.trash', projectId: shared.id },
    ] satisfies ConsoleToServer[]) {
      await hisSocket.deliver(msg);
    }
    await settle();
    assert.ok(projects.get(shared.id), 'someone shared a project deleted it');
    assert.equal(projects.get(shared.id)?.name, 'Shared', 'someone shared a project renamed it');
    assert.equal(projects.get(shared.id)?.trashedAt, undefined, 'someone shared a project trashed it');
    assert.ok(registry.get('sess01'), 'the recordings went with it');
    void hers;
  });

  test('the owner renames it, and everyone who may read it is told', async () => {
    const { relay, hers, projects } = await withProjects();
    await projects.update(hers.id, { sharedWith: [bo.id] });
    const hersSocket = console_(relay, ana);
    const hisSocket = console_(relay, bo);
    await hersSocket.deliver({ type: 'project.rename', projectId: hers.id, name: 'Renamed' } satisfies ConsoleToServer);
    await until(() => hisSocket.received('project.updated')[0], 'bo to hear the new name');
    assert.equal((hisSocket.received('project.updated').at(-1)!['project'] as Project).name, 'Renamed');
  });

  test('deleting a project deletes the recordings in it', async () => {
    const { relay, registry, projects } = await withProjects();
    // A second project, because the home one is refused — the next agent to
    // connect would have nowhere to go.
    const second = await projects.create('Second', ana.id);
    const entry = registry.get('sess01')!;
    entry.meta = { ...entry.meta, projectId: second.id };

    const hersSocket = console_(relay, ana);
    await hersSocket.deliver({ type: 'session.subscribe', sessionId: 'sess01', replay: false } satisfies ConsoleToServer);
    await hersSocket.deliver({ type: 'project.forget', projectId: second.id } satisfies ConsoleToServer);
    await until(() => hersSocket.received('project.removed')[0], 'the project to go');

    assert.equal(projects.get(second.id), undefined);
    assert.equal(registry.get('sess01'), undefined, 'the recording outlived its project');
    assert.deepEqual(
      hersSocket.received('session.removed').map((m) => m['sessionId']),
      ['sess01'],
      'the console was not told the recording went',
    );
  });

  test('the home project is refused, so there is always somewhere for a run to land', async () => {
    const { relay, hers, projects, registry } = await withProjects();
    const hersSocket = console_(relay, ana);
    await hersSocket.deliver({ type: 'project.forget', projectId: hers.id } satisfies ConsoleToServer);
    await settle();
    assert.ok(projects.get(hers.id));
    assert.ok(registry.get('sess01'), 'the recordings went with a refused delete');
  });

  test('only an administrator transfers one, and only to an account that exists', async () => {
    const { relay, hers, projects } = await withProjects();
    // Ana owns it, but owning it is not the same as being able to hand it on.
    await console_(relay, ana).deliver({ type: 'project.transfer', projectId: hers.id, toAccountId: bo.id } satisfies ConsoleToServer);
    await settle();
    assert.equal(projects.get(hers.id)?.owner, ana.id, 'a member transferred a project');

    // An administrator can, which is also how an administrator comes to read
    // a project they do not own: by taking it, which is written down.
    const rootSocket = console_(relay, root);
    await rootSocket.deliver({ type: 'project.transfer', projectId: hers.id, toAccountId: 'not-an-account' } satisfies ConsoleToServer);
    await settle();
    assert.equal(projects.get(hers.id)?.owner, ana.id, 'a typo in the target orphaned the project');

    await rootSocket.deliver({ type: 'project.transfer', projectId: hers.id, toAccountId: bo.id } satisfies ConsoleToServer);
    await until(() => projects.get(hers.id)?.owner === bo.id, 'the handover');
  });

  test('a transfer tells the side that lost it as well as the side that gained it', async () => {
    const { relay, hers, projects } = await withProjects();
    const hersSocket = console_(relay, ana);
    const hisSocket = console_(relay, bo);
    const rootSocket = console_(relay, root);
    await rootSocket.deliver({ type: 'project.transfer', projectId: hers.id, toAccountId: bo.id } satisfies ConsoleToServer);
    await until(() => projects.get(hers.id)?.owner === bo.id, 'the handover');

    assert.deepEqual(hersSocket.received('project.removed').map((m) => m['projectId']), [hers.id]);
    assert.equal((hisSocket.received('project.updated').at(-1)!['project'] as Project).owner, bo.id);
    // And her console can no longer reach what is in it.
    const before = hersSocket.sent.length;
    await hersSocket.deliver({ type: 'session.subscribe', sessionId: 'sess01', replay: true } satisfies ConsoleToServer);
    await settle();
    assert.equal(hersSocket.sent.length, before, 'the old owner still reads the recordings');
  });
});
