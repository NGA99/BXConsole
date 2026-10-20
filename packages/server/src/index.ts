/**
 * bxconsole relay server.
 *
 *   http://localhost:7331/            console UI (built) — in dev use Vite on :5173
 *   http://localhost:7331/agent.js    agent bundle for target pages
 *   http://localhost:7331/demo/       example target page
 *   ws://localhost:7331/ws/agent      agents (pages being debugged)
 *   ws://localhost:7331/ws/console    console UIs
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AGENT_MAX_MESSAGE_BYTES,
  ASSET_MAX_BYTES,
  PING_TOKENS_FILE,
  PRE_PAYLOAD_FILE,
  PRE_PAYLOAD_MAX_BYTES,
  prePayloadFileFor,
  SESSIONS_DIR,
  WS_PATH,
  assetPath,
  decodeAssetUrl,
  isValidPingToken,
  isValidSessionId,
  mayAdminister,
  rewriteCssUrls,
} from '@bxconsole/protocol';
import { SessionRegistry } from './registry';
import { SessionStore } from './store';
import { Relay } from './relay';
import { ProjectStore } from './projects';
import { createStaticHandler } from './static';
import { createAgentHandler } from './agent-handler';
import { ConsoleAuth, isVictimPath, loginPage, refuse } from './auth';
import { RateLimit, limitKey } from './limit';
import { AssetCache } from './assets';
import { BlobStore } from './blobs';
import { AssetCollector } from './collect';
import { PingBoard, PROBE_BODIES, describeRequest, parseProbePath, scriptProbeBody } from './ping';
import { requestOrigin } from './agent-handler';

const PORT = Number(process.env.PORT ?? 7331);
/** Days an untouched recording is kept. 0, the default, keeps everything. */
const RETENTION_DAYS = Number(process.env.SESSION_RETENTION_DAYS ?? 0);
/**
 * Still every interface by default: the point of this relay is that pages on
 * other machines connect to it. The operator's half needs the password and
 * the console socket needs it too, so what is exposed on this port is the
 * victim's half: /agent.js, the agent socket and the probes. Those cannot be
 * authenticated — nobody is at the keyboard — so keep this on a network you
 * trust and read the startup warning.
 */
const HOST = process.env.HOST ?? '0.0.0.0';
/** Browser origins allowed to open the console socket; the agent is not restricted. */
const ALLOWED_ORIGINS = (process.env.CONSOLE_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (bundled): both are one level under packages/server.
const repoRoot = path.resolve(here, '..', '..', '..');

const store = new SessionStore(path.join(repoRoot, 'sessions'));
const registry = new SessionRegistry(store);
const relay = new Relay(registry, store);
/** Who owns which recordings. Read and migrated at boot, below. */
const projects = new ProjectStore(path.join(repoRoot, SESSIONS_DIR), (m) => console.log(`[bxconsole] ${m}`));
/**
 * ACCEPT_KEYLESS, as a project id, or null to refuse keyless runs.
 *
 * Declared here and set at boot, below, because the request handlers read it
 * and they are defined above that point. It was a `const` down there with a
 * `typeof` guard up here pretending to cope with reading it early — which
 * `typeof` does not do for a `const`: it throws like any other access.
 */
let keylessLanding: string | null = null;

/**
 * Subresources of the debugged pages, fetched by the pages themselves.
 * See assets.ts for why the console must not load them directly.
 */
const ASSET_BUDGET = Number(process.env.ASSET_MAX_BYTES ?? ASSET_MAX_BYTES);
/** One copy of every file the pages handed over, shared by every session. */
const blobs = new BlobStore(path.join(repoRoot, 'sessions'), ASSET_BUDGET);
const assets = new AssetCache(blobs, (sessionId, url, tabId) => relay.fetchAsset(sessionId, url, tabId), ASSET_BUDGET);
relay.useBlobs(blobs);
/*
 * Pull in the code a page loads while the page is still open. Without this the
 * bytes are only fetched when someone opens the file in the console, and after
 * the run has ended there is nothing left to fetch them from.
 */
const collector = new AssetCollector(blobs, (sessionId, url, tabId) => relay.fetchAsset(sessionId, url, tabId));
relay.useCollector(collector);
/*
 * Mark and sweep, rather than a reference count. A count is exact until the
 * process dies mid-write and then it is silently wrong; a sweep re-derives
 * the truth from the sessions that exist, so it heals itself. The cost is
 * that deleting a recording does not free its bytes until this has run.
 */
registry.onRemoved = async (sessionId) => {
  blobs.forget(sessionId);
  collector.forget(sessionId);
  const { removed, bytes } = await blobs.sweep();
  if (removed) console.log(`[bxconsole] swept ${removed} unreferenced file(s), ${(bytes / 1024).toFixed(0)} kB`);
};

/**
 * Whether the account behind this request may read this run.
 *
 * The console socket asks the relay the same question for every message that
 * names a session. These two endpoints are the same data over HTTP — the
 * bytes of one run's requests and the files its pages loaded — and they were
 * only asking whether anybody was signed in, which on a relay with one
 * operator was the same question and is not any more.
 *
 * 404 rather than 403 for the refusal, so the answer does not tell a caller
 * which session ids exist.
 */
function mayReadSession(req: http.IncomingMessage, sessionId: string): boolean {
  const meta = registry.get(sessionId)?.meta;
  if (!meta) return false;
  return projects.maySeeSessionIn(meta.projectId, auth.actorFor(req)?.id);
}

/**
 * A recorded request or response body, by content hash.
 *
 * Scoped to the session that recorded it, and now to the account as well.
 * The hash alone would otherwise be a key to any body any run on this relay
 * ever stored, and the relay is already unauthenticated enough without
 * handing out one of those.
 */
async function serveBody(req: http.IncomingMessage, res: http.ServerResponse, requested: URL): Promise<void> {
  const [, , sessionId, sha] = requested.pathname.split('/');
  if (!sessionId || !sha || !isValidSessionId(sessionId) || !/^[0-9a-f]{64}$/.test(sha)) {
    return void plain(res, 400, 'bad body request');
  }
  // Signed in is not enough: these are bytes out of one run's traffic, and
  // the socket gate would refuse the same bytes asked for over the console.
  if (!mayReadSession(req, sessionId)) return void plain(res, 404, 'no such body in this session');
  const record = await blobs.hasBody(sessionId, sha);
  if (!record) return void plain(res, 404, 'no such body in this session');
  const bytes = await blobs.read(sha);
  if (!bytes) return void plain(res, 404, 'the sweep took it');
  res.writeHead(200, {
    'content-type': record.mime || 'application/octet-stream',
    'content-length': String(bytes.length),
    // Content-addressed: these bytes cannot become different bytes.
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(bytes);
}

async function serveAsset(req: http.IncomingMessage, res: http.ServerResponse, requested: URL): Promise<void> {
  const [, , sessionId, encoded] = requested.pathname.split('/');
  if (!sessionId || !encoded || !isValidSessionId(sessionId)) return void plain(res, 400, 'bad asset request');
  if (!mayReadSession(req, sessionId)) return void plain(res, 404, 'no such asset in this session');
  const url = decodeAssetUrl(encoded);
  if (!url) return void plain(res, 400, 'bad asset url');
  // Which window to ask: the one the mirror is showing, so a run spanning
  // several origins asks the window that can actually read the file.
  const tabId = requested.searchParams.get('tab') ?? undefined;
  if (tabId !== undefined && !isValidSessionId(tabId)) return void plain(res, 400, 'bad window id');
  let asset;
  try {
    asset = await assets.get(sessionId, url, tabId);
  } catch (err) {
    console.warn('[bxconsole] asset', url, err);
    return void plain(res, 502, 'asset fetch failed');
  }
  if (!asset) {
    /*
     * We could not get the bytes through the page: no window is connected, or
     * the page itself cannot read them (a cross-origin file served without
     * CORS — an opaque response is opaque to the page too).
     *
     * Send the browser to the original URL. That is exactly what the console
     * did for every subresource before this proxy existed, so the fallback is
     * never worse than that, and everything the page *can* read — which is the
     * whole of a same-origin intranet app — still never goes this way. It does
     * mean the console's own browser resolves that address, with whatever that
     * means on its machine; nothing better is available at this point.
     */
    const mayFallBack = requested.searchParams.get('nofallback') === null;
    if (mayFallBack && /^https?:/i.test(url) && !new URL(url).pathname.startsWith('/asset/')) {
      res.writeHead(302, { location: url, 'cache-control': 'no-store' });
      return void res.end();
    }
    return void plain(res, 404, 'the page could not read it, and it cannot be fetched from here');
  }
  let body = asset.body;
  if (/^text\/css/i.test(asset.mimeType)) {
    // The stylesheet's own url() and @import must come back through here too,
    // or they resolve against /asset/... and 404 — and they carry the same
    // window, or a sheet from one origin would have its pictures asked of a
    // window on another.
    body = Buffer.from(
      rewriteCssUrls(body.toString('utf8'), url, (abs) => assetPath(sessionId, abs, tabId ? { tabId } : undefined)),
      'utf8',
    );
  }
  res.writeHead(200, {
    'content-type': asset.mimeType,
    'content-length': body.length,
    // Keyed by URL and stored for the life of the recording, so re-asking is
    // pure overhead; an hour keeps a long debugging session quiet without
    // pinning a stale file forever.
    'cache-control': 'public, max-age=3600',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function plain(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/**
 * Connectivity probes. Which of these arrive tells the console which way into
 * the relay a page is allowed to take — see ping.ts.
 */
const ping = new PingBoard();
// A token is good for a day; the relay restarts far more often than that.
ping.useFile(path.join(repoRoot, 'sessions', PING_TOKENS_FILE));
relay.watchPings(ping);

function servePing(req: http.IncomingMessage, res: http.ServerResponse, requested: URL): boolean {
  const { pathname } = requested;
  if (pathname === '/ping' || pathname === '/ping/') {
    // Token-free, for checking from the target machine before touching the app.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify(
        { ok: true, relay: process.env.PUBLIC_ORIGIN ?? requestOrigin(req), now: new Date().toISOString(), yourIp: req.socket.remoteAddress, origin: req.headers.origin ?? null },
        null,
        2,
      ),
    );
    return true;
  }
  if (pathname === '/ping/new' && req.method === 'POST') {
    /*
     * The operator's, not the victim's.
     *
     * It used to need no password, alongside the probe routes — and it is not
     * like them. A victim's browser only ever fetches `/ping/{probe}/{token}`
     * with a token the console baked into the snippet; nothing in a page asks
     * for a token. So this was an endpoint anyone who found the port could
     * use to mint tokens, and now the account that asks is also the account
     * that may read what arrives.
     */
    const actor = auth.actorFor(req);
    if (!actor) return refuse(req, res), true;
    const issued = ping.issue(actor.id);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(issued));
    return true;
  }
  /*
   * Is this token still live?
   *
   * The console asks before it starts listening, because a dead token fails
   * in the one way a diagnostic tool must not: the probe gets a 200, the page
   * looks fine, and the tab sits empty. Knowing lets it say "expired — make a
   * new one" instead of nothing at all.
   */
  if (pathname.startsWith('/ping/check/')) {
    const token = decodeURIComponent(pathname.slice('/ping/check/'.length).replace(/\/$/, ''));
    // Live to the account that owns it, and not live to anybody else, so
    // this cannot be used to find out which tokens exist.
    const actor = auth.actorFor(req);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ live: isValidPingToken(token) && ping.isOwnedBy(token, actor?.id) }));
    return true;
  }
  const probe = parseProbePath(pathname);
  if (!probe) return false;
  // An unknown token is still answered: refusing would make a CSP problem look
  // like a relay problem, which is the confusion this whole thing exists to end.
  // The console notices the token is dead and says so — see /ping/check.
  if (ping.knows(probe.token)) {
    const page = requested.searchParams.get('page');
    const xfo = requested.searchParams.get('xfo');
    const fa = requested.searchParams.get('fa');
    ping.record({
      token: probe.token,
      probe: probe.probe,
      ts: Date.now(),
      ...describeRequest(req.headers, req.socket.remoteAddress, req.method, requested.pathname + requested.search),
      ...(page ? { pageUrl: page } : {}),
      // Only the script probe reports these, and only once it was allowed to run.
      ...(xfo !== null || fa !== null ? { framing: { xFrameOptions: xfo ?? '', frameAncestors: fa ?? '' } } : {}),
    });
  }
  const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (probe.probe === 'script') {
    const origin = process.env.PUBLIC_ORIGIN ?? requestOrigin(req);
    const body = scriptProbeBody(origin, probe.token, origin.replace(/^http/, 'ws'));
    res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
    res.end(body);
    return true;
  }
  if (probe.probe === 'websocket') {
    // Reached over plain HTTP, so it was not an upgrade; say so rather than 404.
    res.writeHead(426, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('this probe expects a WebSocket upgrade');
    return true;
  }
  const canned = PROBE_BODIES[probe.probe];
  res.writeHead(200, { ...headers, 'content-type': canned.type, 'content-length': canned.body.length });
  res.end(req.method === 'HEAD' ? undefined : canned.body);
  return true;
}

/*
 * The pre-payload: one script, stored on disk, handed to agents whose payload
 * asked for it with `pre=1`.
 *
 * On disk rather than in memory so it survives a restart — a payload planted
 * in a stored sink may not fire for weeks, and the relay will have been
 * restarted by then. Read on each request rather than cached, so editing it
 * in the console takes effect for the next agent without a restart.
 */
const sessionsDir = path.join(repoRoot, SESSIONS_DIR);
/** The relay-wide file, from before there was one per project. */
const legacyPrePayloadPath = path.join(sessionsDir, PRE_PAYLOAD_FILE);
const prePayloadPathFor = (projectId: string): string => path.join(sessionsDir, prePayloadFileFor(projectId));

/**
 * The script to hand an agent, for the project its key named.
 *
 * The home project also answers from the relay-wide file, so a script set
 * before pre-payloads were per-project keeps running for the engagement it
 * was set for — but only for that one. Every other project starts with none,
 * which is the correct answer for a project that has never been given one.
 */
async function readPrePayload(projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const candidates = [prePayloadPathFor(projectId)];
  if (projectId === projects.homeId()) candidates.push(legacyPrePayloadPath);
  for (const file of candidates) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      /* never written, or removed */
    }
  }
  return null;
}

const serveAgent = createAgentHandler(path.join(repoRoot, 'packages/agent/dist/agent.js'), {
  publicOrigin: process.env.PUBLIC_ORIGIN,
  /*
   * Resolved from the key in the request, not from who is asking — nobody is
   * asking: this is a victim's browser fetching the bundle. A request with no
   * key, or one this relay does not know, gets no pre-payload at all. Which
   * is the same rule the hello is held to, and it has to be: handing the
   * script to a payload whose run is about to be refused would run code in
   * somebody's browser and then record none of it.
   */
  prePayload: (key) => readPrePayload(key ? (projects.byAgentKey(key)?.id ?? null) : keylessLanding),
});

/**
 * Read and write a project's pre-payload. Operator surface, not the victim's:
 * a GET returns what is stored, a PUT replaces it, and an empty PUT body
 * removes it so no agent receives one.
 *
 * The owner's, not anybody who may read the project. Being shared an
 * engagement is being able to read its recordings; this is arbitrary code in
 * every browser that installs an agent for it, which is the owner's to set.
 *
 * `?project=` picks one, and no `project=` means the home project — so the
 * console as it stands, which asks for `/pre-payload` and knows nothing about
 * projects, still reaches the one a fresh install has.
 */
async function servePrePayload(req: http.IncomingMessage, res: http.ServerResponse, requested: URL): Promise<void> {
  const wanted = requested.searchParams.get('project') ?? projects.homeId() ?? '';
  const project = projects.get(wanted);
  const actor = auth.actorFor(req);
  if (!project || !mayAdminister(project, actor?.id)) return void plain(res, 404, 'no such project');
  const prePayloadPath = prePayloadPathFor(project.id);

  if (req.method === 'GET') {
    const source = await readPrePayload(project.id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ source: source ?? '' }));
  }
  if (req.method !== 'PUT') return void plain(res, 405, 'GET or PUT');

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // It travels inline with every agent.js request that asks for it, so a
    // runaway script would be paid for on every single install.
    if (size > PRE_PAYLOAD_MAX_BYTES) return void plain(res, 413, `pre-payload is limited to ${PRE_PAYLOAD_MAX_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const source = Buffer.concat(chunks).toString('utf8');
  await fs.mkdir(path.dirname(prePayloadPath), { recursive: true });
  if (source.trim()) await fs.writeFile(prePayloadPath, source);
  else await fs.rm(prePayloadPath, { force: true });
  /*
   * Clearing the home project's also clears the relay-wide file it still
   * reads. Without this, "remove the pre-payload" would appear to work and
   * the old script would come straight back on the next agent — the file it
   * falls back to is invisible from the console.
   */
  if (!source.trim() && project.id === projects.homeId()) await fs.rm(legacyPrePayloadPath, { force: true });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, bytes: source.trim() ? Buffer.byteLength(source) : 0 }));
}

const serveStatic = createStaticHandler({
  '/agent.js.map': path.join(repoRoot, 'packages/agent/dist/agent.js.map'),
  /*
   * The same agent, built without minifying, for reading in the console.
   * Pretty-printing the shipped bundle gives back the shape but not the
   * names, and names are most of what makes source worth reading.
   */
  '/agent.source.js': path.join(repoRoot, 'packages/agent/dist/agent.readable.js'),
  '/demo/': path.join(repoRoot, 'examples/demo-page'),
  // A -> B -> C, for testing that one run spans several windows.
  '/chain/': path.join(repoRoot, 'examples/chain'),
  // Large DOM, large response, large file: the console on something real-sized.
  '/stress/': path.join(repoRoot, 'examples/stress'),
  '/': path.join(repoRoot, 'packages/console/dist'),
});

/** The console UI is served from this relay, so its own origin is always fine. */
function consoleOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser client (curl, a test, a tunnel)
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname, port } = new URL(origin);
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
    return loopback && (port === String(PORT) || port === '5173');
  } catch {
    return false;
  }
}

const passwdPath = process.env.PASSWD_FILE ?? path.join(repoRoot, '.passwd');
const auth = new ConsoleAuth({
  file: passwdPath,
  warn: (message) => console.log(`[bxconsole] ${message}`),
});

/*
 * Guessing the password is only limited by how fast it can be tried, so this
 * is the lockout: five wrong answers a minute from one address. A correct one
 * clears the count, so an operator who mistypes twice is not locked out of
 * their own relay.
 */
const loginLimit = new RateLimit(5, 60_000);

/*
 * The agent socket cannot be authenticated. The agent runs in a browser that
 * is not ours, so anything we put in it to prove itself is readable by anyone
 * who can read the payload — which is the point of a blind XSS payload being
 * where it is. What is left is to bound it: a session is created by whoever
 * opens this socket and says hello, and each one is a file on disk and a row
 * in the console's list.
 *
 * The allowance is generous because every navigation re-injects the agent and
 * opens a new socket, and a whole office can share one address. It is here to
 * turn an unbounded flood into a trickle, not to stop a determined caller.
 */
const agentLimit = new RateLimit(120, 60_000);

/** Take a password from the sign-in form and hand back the cookie. */
async function serveLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) return void plain(res, 413, 'too long');
    chunks.push(chunk as Buffer);
  }
  const key = limitKey(req.socket.remoteAddress);
  if (!loginLimit.allow(key)) {
    res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60', 'Cache-Control': 'no-store' });
    return void res.end(loginPage(false, true));
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const password = form.get('password') ?? '';
  // An empty name means a form from before there were several accounts —
  // and a relay running on CONSOLE_PASSWORD, where there is only ever one.
  const user = (form.get('user') ?? '').trim();
  const setCookie = await (user ? auth.cookieFor(password, user) : auth.cookieFor(password));
  if (!setCookie) {
    // Slow as well as limited: the pause costs a human one mistype and costs a
    // script the only thing it has, which is attempts per second.
    await new Promise((r) => setTimeout(r, 400));
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return void res.end(loginPage(true, false, user));
  }
  loginLimit.clear(key);
  res.writeHead(303, { 'Set-Cookie': setCookie, Location: '/', 'Cache-Control': 'no-store' });
  res.end();
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const requested = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = requested;

  if (pathname === '/login' && req.method === 'POST') {
    return void serveLogin(req, res).catch(() => plain(res, 500, 'login error'));
  }
  /*
   * Everything that is not reached by a victim's browser needs the password.
   * Closed by default on purpose: a route added later is protected without
   * anyone remembering to protect it.
   */
  if (!isVictimPath(pathname) && !auth.allows(req)) return void refuse(req, res);

  if (pathname === '/agent.js') return void serveAgent(req, res);
  if (pathname === '/pre-payload') {
    return void servePrePayload(req, res, requested).catch(() => plain(res, 500, 'pre-payload error'));
  }
  if (pathname === '/ping' || pathname.startsWith('/ping/')) {
    if (servePing(req, res, requested)) return;
  }
  if (pathname.startsWith('/body/')) {
    return void serveBody(req, res, requested).catch(() => plain(res, 500, 'body error'));
  }
  if (pathname.startsWith('/asset/')) {
    void serveAsset(req, res, requested).catch(() => plain(res, 500, 'asset error'));
    return;
  }
  serveStatic(req, res);
});

/*
 * The agent socket is the one nothing can authenticate — a victim's browser
 * has nobody at the keyboard — so it is the one that needs a ceiling on what
 * a single message may be. See AGENT_MAX_MESSAGE_BYTES for where the figure
 * comes from. Past it `ws` closes the connection with 1009, and the agent's
 * transport reconnects with its usual backoff.
 */
const agentWss = new WebSocketServer({ noServer: true, maxPayload: AGENT_MAX_MESSAGE_BYTES });
/** The connectivity probe socket: accepted, recorded, closed. */
const pingWss = new WebSocketServer({ noServer: true });
const consoleWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === WS_PATH.console) {
    // WebSocket handshakes ignore CORS, so without the origin check any page
    // the user visits could open this socket and evaluate code in their
    // debugged pages. The cookie rides along on the handshake by itself,
    // which is why the password is a cookie and not a header.
    if (!consoleOriginAllowed(req.headers.origin) || !auth.allows(req)) {
      socket.destroy();
      return;
    }
  }
  if (pathname.startsWith('/ping/websocket/')) {
    /*
     * No origin check here, unlike the console socket. This one is reached
     * from whatever page is being diagnosed, which is the point of it — and
     * it carries nothing: the probe is recorded, the socket is closed.
     */
    const probe = parseProbePath(pathname);
    if (!probe) return void socket.destroy();
    pingWss.handleUpgrade(req, socket, head, (ws) => {
      if (ping.knows(probe.token)) {
        ping.record({
          token: probe.token,
          probe: 'websocket',
          ts: Date.now(),
          ...describeRequest(req.headers, req.socket.remoteAddress, 'GET', pathname),
        });
      }
      ws.close();
    });
    return;
  }
  if (pathname === WS_PATH.agent) {
    /*
     * A browser always sends Origin on a WebSocket handshake; curl and wscat
     * do not. The value is not checked and cannot be — a blind XSS payload
     * fires on pages we have not been told about, which is the whole premise,
     * so there is no list to check it against. Only its presence is, which
     * costs nothing and turns away the casual probe that found the port.
     *
     * Anyone who sets the header walks past this. It is a filter, not a
     * boundary, and the limit below is what actually bounds the damage.
     */
    if (req.headers.origin === undefined) return void socket.destroy();
    if (!agentLimit.allow(limitKey(req.socket.remoteAddress))) return void socket.destroy();
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      armHeartbeat(ws);
      relay.attachAgent(ws);
    });
  } else if (pathname === WS_PATH.console) {
    consoleWss.handleUpgrade(req, socket, head, (ws) => {
      armHeartbeat(ws);
      relay.attachConsole(ws, auth.actorFor(req) ?? undefined);
    });
  } else {
    socket.destroy();
  }
});

/**
 * A page that dies without closing cleanly — the browser quit, the machine
 * slept, the network dropped — leaves a half-open socket that the OS may hold
 * for many minutes. The session would keep showing as connected and commands
 * sent to it would vanish. Ping every socket and drop the ones that stop
 * answering, which is what turns the row grey.
 */
const HEARTBEAT_MS = 15_000;
type Alive = { isAlive?: boolean };

/** `noServer` upgrades never emit 'connection', so arm each socket here. */
function armHeartbeat(ws: WebSocket): void {
  (ws as unknown as Alive).isAlive = true;
  ws.on('pong', () => {
    (ws as unknown as Alive).isAlive = true;
  });
}

const heartbeat = setInterval(() => {
  for (const wss of [agentWss, consoleWss]) {
    for (const ws of wss.clients) {
      if ((ws as Alive).isAlive === false) {
        ws.terminate(); // fires 'close', so the registry marks the window gone
        continue;
      }
      (ws as Alive).isAlive = false;
      ws.ping();
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// A rejection anywhere must not take the relay down with every session on it.
process.on('unhandledRejection', (err) => {
  console.warn('[bxconsole] unhandled rejection:', err instanceof Error ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.warn('[bxconsole] uncaught exception:', err.stack ?? err.message);
});

try {
  await store.lock();
} catch (err) {
  console.error(`[bxconsole] ${err instanceof Error ? err.message : err}`);
  console.error('[bxconsole] two relays on one sessions/ directory corrupt the recordings; stop the other one first.');
  process.exit(1);
}

/*
 * Read .passwd before listening. A file the operator has to fix should stop
 * the relay now, with the reason, rather than at the first sign-in attempt.
 */
try {
  auth.load();
} catch (err) {
  console.error(`[bxconsole] ${(err as Error).message}`);
  process.exit(1);
}

await registry.loadFromDisk();

/*
 * Projects, and the one-time move of whatever is already here into one.
 *
 * After the registry, because the migration stamps the sessions it finds and
 * the registry is what found them; before listening, because the first agent
 * to connect needs a project to go into.
 *
 * The project is owned by the first account in `.passwd` — the administrator,
 * on a file written by the CLI — because there is nobody else it could belong
 * to: the recordings predate accounts, and the person who has been running
 * this relay is the person whose password opens it.
 */
await projects.load();
await projects.migrateInto(auth.ownerForMigration(), registry.all(), (meta) => store.writeMeta(meta));

/*
 * ACCEPT_KEYLESS: the project a payload with no key lands in.
 *
 * The transition, and it is off unless asked for. Keys did not exist when
 * the payloads now in flight were built, and those are in browsers nobody
 * can reach — so an operator names a project to catch them, replaces the
 * payloads, and unsets this. Checked here rather than on each hello: a name
 * that is not a project is a thing to say once at startup, not to discover
 * when a session fails to appear.
 */
keylessLanding = ((): string | null => {
  const wanted = process.env.ACCEPT_KEYLESS?.trim();
  if (!wanted) return null;
  const project = projects.get(wanted);
  if (!project) {
    console.error(`[bxconsole] ACCEPT_KEYLESS names "${wanted}", which is not a project on this relay.`);
    console.error('[bxconsole] Keyless runs stay refused. Pick one of:');
    for (const p of projects.all()) console.error(`[bxconsole]   ${p.id}  ${p.name}`);
    return null;
  }
  console.log(`[bxconsole] ACCEPT_KEYLESS: payloads with no key land in "${project.name}" (${project.id})`);
  return project.id;
})();
relay.useProjects(projects);
relay.useAccountIds(() => auth.accountIds());
relay.useAccounts({
  summaries: () => auth.summaries(),
  change: (change) => auth.changeAccounts(change),
});
relay.useKeylessLanding(() => keylessLanding);

relay.startRetention(RETENTION_DAYS);

server.listen(PORT, HOST, () => {
  console.log(`[bxconsole] relay listening on http://localhost:${PORT}`);
  const origin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
  /*
   * The snippet, with a key in it.
   *
   * Printed because there is nowhere else to get one yet: a payload needs a
   * project key, and the console has no screen that shows them. The home
   * project's is the one a fresh install wants. It is not a secret — it rides
   * in the injected script, where the page can read it — and all it can do is
   * write runs into that project.
   */
  const home = projects.get(projects.homeId() ?? '');
  const keyed = home ? ` data-key="${home.agentKey}"` : '';
  console.log(`[bxconsole] agent:   <script src="${origin}/agent.js"${keyed} data-name="..."></script>`);
  if (home) {
    console.log(`[bxconsole]          or  import("${origin}/agent.js?key=${home.agentKey}&name=...")`);
    const keyless = keylessLanding ? projects.get(keylessLanding) : undefined;
    console.log(
      keyless
        ? `[bxconsole]          that key puts runs in "${home.name}"; a payload with no key lands in "${keyless.name}".`
        : `[bxconsole]          that key puts runs in "${home.name}"; a payload with no key is refused. Set ACCEPT_KEYLESS to change that.`,
    );
  } else {
    console.log(`[bxconsole]          or  import("${origin}/agent.js?name=...")`);
  }
  console.log(`[bxconsole] console: http://localhost:${PORT}/  (dev: http://localhost:5173/)`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    /*
     * These two used to print together and contradicted each other, one
     * saying the console was protected and the next that it was open. What is
     * true is that the operator's half is protected and the victim's half
     * cannot be, so say exactly that.
     */
    console.log(
      auth.source === 'file'
        ? `[bxconsole] operator access: the accounts in ${path.relative(repoRoot, passwdPath) || passwdPath}`
        : `[bxconsole] operator access: CONSOLE_PASSWORD${auth.isDefault ? ' — still the default from the repository. Run: npm run passwd' : ''}`,
    );
    console.log(`[bxconsole] reachable on the network (HOST=${HOST}). /agent.js, ${WS_PATH.agent} and /ping cannot ask for a`);
    console.log(`[bxconsole] password — nobody is at the keyboard — so keep this on a network you trust.`);
  }
});
