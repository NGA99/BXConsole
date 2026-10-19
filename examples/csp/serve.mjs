/**
 * Four pages that differ only in their Content-Security-Policy, for trying
 * the console's Connectivity tab against something that really does block a
 * way in.
 *
 *   node examples/csp/serve.mjs            # http://127.0.0.1:7405
 *   npm run csp-cases
 *
 * A separate origin on purpose: CSP is the page's, not the relay's, and a
 * second origin is also closer to the thing being simulated — an app that
 * lives somewhere other than the relay.
 *
 * Paste the snippet from the Connectivity tab into the box on the index page
 * and pick a case. The headline in the console should name the directive that
 * case blocks.
 *
 * Adding `?agent=1` to a case loads the agent itself, which is how the
 * hosting fallback is checked by hand: on `allowed` the page should end up
 * inside a frame, and on `no-frame` and `frame-deny-header` the agent should
 * put the page back as it was and attach to it directly. There is no unit
 * test for that — whether a browser refuses a frame is the browser's answer,
 * not ours.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 7405);
const RELAY = process.env.RELAY ?? 'http://localhost:7331';
const WS_RELAY = RELAY.replace(/^http/, 'ws');

/** Each case says what it allows from the relay, and what the console should then say. */
const CASES = {
  open: {
    title: 'No CSP at all',
    csp: null,
    expect: 'Every way through is open',
  },
  'no-script': {
    title: 'Images and styles allowed, scripts not',
    csp: `default-src 'self'; img-src 'self' ${RELAY}; style-src 'self' ${RELAY}; script-src 'self'`,
    expect: 'The network is fine; scripts are blocked',
  },
  'no-connect': {
    title: 'Scripts allowed, connections not',
    csp: `default-src 'self'; img-src 'self' ${RELAY}; style-src 'self' ${RELAY}; script-src 'self' ${RELAY}; connect-src 'self'`,
    expect: 'Scripts run, but nothing can connect',
  },
  'no-socket': {
    title: 'Everything but the WebSocket',
    csp: `default-src 'self'; img-src 'self' ${RELAY}; style-src 'self' ${RELAY}; script-src 'self' ${RELAY}; connect-src 'self' ${RELAY}`,
    expect: 'HTTP works, the WebSocket does not',
  },
  allowed: {
    title: 'Everything the agent needs, spelled out',
    csp: `default-src 'self'; img-src 'self' ${RELAY}; style-src 'self' ${RELAY}; script-src 'self' ${RELAY}; connect-src 'self' ${RELAY} ${WS_RELAY}`,
    expect: 'Every way through is open',
  },
  // Framing, which the agent's iframe option would need. The probes all get
  // through on these two; only the page's own framing headers differ.
  'no-frame': {
    frames: false,
    title: 'Open, but refuses to be framed',
    csp: `default-src 'self'; img-src 'self' ${RELAY}; style-src 'self' ${RELAY}; script-src 'self' ${RELAY}; connect-src 'self' ${RELAY} ${WS_RELAY}; frame-ancestors 'none'`,
    expect: 'Every way through is open — and this page cannot be put in a frame',
  },
  'frame-deny-header': {
    frames: false,
    title: 'Open, with the old X-Frame-Options: DENY',
    csp: `default-src 'self'; img-src 'self' ${RELAY}; style-src 'self' ${RELAY}; script-src 'self' ${RELAY}; connect-src 'self' ${RELAY} ${WS_RELAY}`,
    xfo: 'DENY',
    expect: 'Every way through is open — and this page cannot be put in a frame',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = `body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.55}
code,pre{background:#f1f3f4;border-radius:4px}code{padding:1px 5px}
pre{padding:10px 12px;overflow:auto;white-space:pre-wrap;word-break:break-all}
a{color:#1a73e8}ul{padding-left:20px}li{margin:6px 0}
textarea{width:100%;height:90px;font-family:ui-monospace,monospace;font-size:13px}
button{padding:8px 14px;font-size:14px}`;

function indexPage() {
  const items = Object.entries(CASES)
    .map(
      ([id, c]) =>
        `<li><a href="/${id}" data-case="${id}"><strong>${esc(id)}</strong></a> — ${esc(c.title)}<br>
         <small>console should say: <em>${esc(c.expect)}</em></small></li>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>CSP cases</title><style>${STYLE}</style></head><body>
<h1>CSP cases</h1>
<p>For trying the console's <strong>Connectivity</strong> tab. Copy the snippet from that tab, paste it below, then open a case.
Each one allows the relay through some directives and not others, so the console's headline should name the one being blocked.</p>
<p>Relay: <code>${esc(RELAY)}</code> (override with <code>RELAY=… node examples/csp/serve.mjs</code>)</p>
<textarea id="snippet" placeholder="Paste the three lines from the Connectivity tab here"></textarea>
<p><button id="save">Use this snippet</button> <span id="saved"></span></p>
<ul>${items}</ul>
<script>
  var box = document.getElementById('snippet');
  box.value = localStorage.getItem('bsc.csp.snippet') || '';
  document.getElementById('save').onclick = function () {
    localStorage.setItem('bsc.csp.snippet', box.value);
    document.getElementById('saved').textContent = 'saved — now pick a case below';
  };
  // The snippet travels in the URL, because the case pages must carry the
  // probe tags in their own HTML: building them with JS would never run in
  // the very case we are testing.
  document.querySelectorAll('a[data-case]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      location.href = a.getAttribute('href') + '?s=' + encodeURIComponent(box.value || localStorage.getItem('bsc.csp.snippet') || '');
    });
  });
</script>
</body></html>`;
}

/**
 * Only the probe tags are taken from what was pasted, and only their URLs:
 * this page is a test fixture, not a place to run someone's markup.
 */
function probeTags(pasted) {
  const tokens = [...pasted.matchAll(/\/ping\/(img|style|script)\/([A-Za-z0-9]{6,32})/g)];
  const token = tokens[0]?.[2];
  if (!token) return null;
  return [
    `<img src="${RELAY}/ping/img/${token}" alt="" hidden>`,
    `<link rel="stylesheet" href="${RELAY}/ping/style/${token}">`,
    `<script src="${RELAY}/ping/script/${token}"></script>`,
  ].join('\n');
}

function casePage(id, pasted, agent) {
  const c = CASES[id];
  const tags = probeTags(pasted);
  return `<!doctype html><html><head><meta charset="utf-8"><title>CSP: ${esc(id)}</title><style>${STYLE}</style></head><body>
<p><a href="/">&larr; all cases</a></p>
<h1>${esc(id)}</h1>
<p>${esc(c.title)}</p>
<pre>${esc(c.csp ?? '(no Content-Security-Policy header)')}</pre>
<p>The console's Connectivity tab should now say:<br><strong>${esc(c.expect)}</strong></p>
${agent ? `<p><small>The agent is loading. ${esc(c.frames === false ? 'This page refuses to be framed, so it should look exactly as it does now and the run should attach to it directly.' : 'This page can be framed, so it should end up inside one.')}</small></p>\n<script src="${RELAY}/agent.js?name=csp-${esc(id)}"></script>` : `<p><small><a href="?agent=1">Load the agent here</a> to check the hosting fallback.</small></p>`}
${tags ? `<p><small>Probes below are live. Watch the console.</small></p>\n${tags}` : ''}
</body></html>`;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = url.pathname.replace(/^\/|\/$/g, '');
    if (!id) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(indexPage());
    }
    const c = CASES[id];
    if (!c) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`cases: ${Object.keys(CASES).join(' ')}`);
    }
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (c.csp) headers['content-security-policy'] = c.csp;
    if (c.xfo) headers['x-frame-options'] = c.xfo;
    res.writeHead(200, headers);
    res.end(casePage(id, url.searchParams.get('s') ?? '', url.searchParams.get('agent') === '1'));
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[csp-cases] http://127.0.0.1:${PORT}  — relay ${RELAY}`);
    for (const [id, c] of Object.entries(CASES)) console.log(`  /${id.padEnd(11)} ${c.expect}`);
  });
