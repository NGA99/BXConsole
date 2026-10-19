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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { ASSET_MAX_BYTES, PING_TOKENS_FILE, WS_PATH, assetPath, decodeAssetUrl, isValidPingToken, isValidSessionId, rewriteCssUrls } from '@bxconsole/protocol';
import { SessionRegistry } from './registry';
import { SessionStore } from './store';
import { Relay } from './relay';
import { createStaticHandler } from './static';
import { createAgentHandler } from './agent-handler';
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
 * other machines connect to it. The console socket has no authentication, so
 * that also means anyone who can reach this port can read the recordings and
 * evaluate expressions in the debugged pages — there is a warning at startup,
 * and the browser-origin check below closes the easier half of it.
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
 * A recorded request or response body, by content hash.
 *
 * Scoped to the session that recorded it. The hash alone would otherwise be a
 * key to any body any run on this relay ever stored, and the relay is already
 * unauthenticated enough without handing out one of those.
 */
async function serveBody(res: http.ServerResponse, requested: URL): Promise<void> {
  const [, , sessionId, sha] = requested.pathname.split('/');
  if (!sessionId || !sha || !isValidSessionId(sessionId) || !/^[0-9a-f]{64}$/.test(sha)) {
    return void plain(res, 400, 'bad body request');
  }
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
    const issued = ping.issue();
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
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ live: isValidPingToken(token) && ping.knows(token) }));
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

const serveAgent = createAgentHandler(path.join(repoRoot, 'packages/agent/dist/agent.js'), {
  publicOrigin: process.env.PUBLIC_ORIGIN,
});

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

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const requested = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = requested;
  if (pathname === '/agent.js') return void serveAgent(req, res);
  if (pathname === '/ping' || pathname.startsWith('/ping/')) {
    if (servePing(req, res, requested)) return;
  }
  if (pathname.startsWith('/body/')) {
    return void serveBody(res, requested).catch(() => plain(res, 500, 'body error'));
  }
  if (pathname.startsWith('/asset/')) {
    void serveAsset(req, res, requested).catch(() => plain(res, 500, 'asset error'));
    return;
  }
  serveStatic(req, res);
});

const agentWss = new WebSocketServer({ noServer: true });
/** The connectivity probe socket: accepted, recorded, closed. */
const pingWss = new WebSocketServer({ noServer: true });
const consoleWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === WS_PATH.console && !consoleOriginAllowed(req.headers.origin)) {
    // WebSocket handshakes ignore CORS, so without this any page the user
    // visits could open this socket and evaluate code in their debugged pages.
    socket.destroy();
    return;
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
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      armHeartbeat(ws);
      relay.attachAgent(ws);
    });
  } else if (pathname === WS_PATH.console) {
    consoleWss.handleUpgrade(req, socket, head, (ws) => {
      armHeartbeat(ws);
      relay.attachConsole(ws);
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

await registry.loadFromDisk();
relay.startRetention(RETENTION_DAYS);

server.listen(PORT, HOST, () => {
  console.log(`[bxconsole] relay listening on http://localhost:${PORT}`);
  const origin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
  console.log(`[bxconsole] agent:   <script src="${origin}/agent.js" data-name="..."></script>  or  import("${origin}/agent.js?name=...")`);
  console.log(`[bxconsole] console: http://localhost:${PORT}/  (dev: http://localhost:5173/)`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`[bxconsole] reachable on the network (HOST=${HOST}) and unauthenticated: anyone who can reach this port can read`);
    console.log(`[bxconsole] every recording and evaluate expressions in the debugged pages. Keep it on a trusted network.`);
  }
});
