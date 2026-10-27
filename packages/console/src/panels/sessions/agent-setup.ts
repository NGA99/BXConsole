/**
 * What the Agent tab hands out, apart from React.
 *
 * The options are the agent's own (see the agent's config.ts). They travel as
 * `data-*` on a script tag and as query parameters everywhere else, so one set
 * of choices has to produce every form of the snippet identically — which is
 * the part worth pinning down in a test rather than in a browser.
 */

/** Agent options worth a control. The rest (server, session, tab) are plumbing. */
export interface Options {
  record: boolean;
  bodies: boolean;
  adopt: boolean;
  frame: boolean;
  collect: boolean;
  /** ask the relay for the stored pre-payload and run it at install */
  pre: boolean;
}

/** What the tab was last set up to hand out, so a reload does not undo it. */
export interface Setup extends Options {
  name: string;
  /**
   * The key of the project this run should land in.
   *
   * Filled from the project list when a snippet is built, never saved — see
   * paramsFor. Empty means this account has no project for new runs, and the
   * tab says so instead of handing out a payload that will be turned away.
   */
  key: string;
}

/**
 * Every option on, which is also what the agent assumes when a snippet says
 * nothing. So a run with nothing turned off needs no parameters at all, and
 * the tab hands out a bare script tag.
 */
/**
 * Everything on except the pre-payload and Nest. The pre-payload runs code of
 * its own in someone else's browser, so it never arrives switched on. Nesting
 * rewrites the page it debugs — window.top is no longer the app, frame-busting
 * undoes it, the address bar freezes — and a page that refuses framing has to
 * fall back, so it is a choice to make per target rather than a default.
 */
export const DEFAULTS: Setup = {
  name: "my-app",
  key: "",
  record: true,
  bodies: true,
  adopt: true,
  frame: false,
  collect: true,
  pre: false,
};
export const SETUP_KEY = "bxconsole.agent.setup";

/**
 * Read the saved setup, falling back to the defaults for anything missing.
 *
 * Merged field by field on purpose: an option added after someone last used
 * the tab is absent from their stored object, and taking it as `false` would
 * silently turn off something that defaults to on.
 */
export function loadSetup(
  storage: Pick<Storage, "getItem"> = localStorage,
): Setup {
  try {
    return {
      ...DEFAULTS,
      ...(JSON.parse(storage.getItem(SETUP_KEY) ?? "{}") as Partial<Setup>),
      // Never from storage, even if an older build put one there: a rotated
      // key read back out of the browser is a snippet that looks right and
      // records nothing. The live project list is the only source.
      key: "",
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveSetup(
  setup: Setup,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    // Without the key. It belongs to the project, not to this browser's idea
    // of how the tab was last left, and it can be rotated out from under a
    // saved copy.
    const { key: _live, ...kept } = setup;
    storage.setItem(SETUP_KEY, JSON.stringify(kept));
  } catch {
    /* a console in a private window still works, it just forgets */
  }
}

/**
 * The non-default choices, as the agent reads them.
 *
 * Only what differs from the agent's own defaults: a snippet carrying every
 * option says nothing about which ones were chosen, and is longer to read.
 */
export function paramsFor(setup: Setup): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  /*
   * The project key first, because it is the one that is not an option.
   *
   * Every other parameter here changes how a run is recorded; this one
   * decides whether it is recorded at all. A payload with no key is refused,
   * so a snippet without it is a snippet that does nothing — which is the
   * failure this tool is worst at, since it fires in a browser nobody can
   * reach and there is nothing to look at afterwards.
   *
   * It is not part of the saved setup, and must not be: a key can be rotated,
   * and a copy kept in the browser would go on being pasted into pages long
   * after it stopped working. It comes from the project list each time.
   */
  if (setup.key) out.push(["key", setup.key]);
  if (setup.name.trim()) out.push(["name", setup.name.trim()]);
  // Only the switches that are off: a parameter in the snippet should mean
  // "this run is not the usual one", so that reading it tells you what the
  // person chose rather than restating the defaults back at them.
  if (!setup.record) out.push(["screen", "viewer"]);
  if (!setup.bodies) out.push(["bodies", "0"]);
  if (!setup.adopt) out.push(["adopt", "0"]);
  if (!setup.collect) out.push(["collect", "0"]);
  // The two exceptions to the rule above, both off by default, so each shows
  // up when it is turned ON rather than off. Nest (frame) travels like the
  // others, as a data attribute or a query param. pre only ever travels in
  // the query — the relay has to see it to know to send the script, and it
  // never reads a data attribute.
  if (setup.frame) out.push(["frame", "host"]);
  if (setup.pre) out.push(["pre", "1"]);
  return out;
}

/**
 * Percent-encoding for a URL that will sit inside a JavaScript string.
 *
 * `encodeURIComponent` leaves an apostrophe alone, which is correct for a URL
 * and wrong here: three of the snippets below are JavaScript with the address
 * in single quotes, so a run named `client\'s site` closed the string early
 * and the payload became a syntax error. It was copied, pasted into whatever
 * field the engagement had, and silently did nothing — on a tool that often
 * gets one attempt. `%27` means the same thing to the relay and ends no
 * string. The parenthesis pair goes too: they are legal in a URL and end an
 * argument list in a bookmarklet.
 */
function encodeForSnippet(value: string): string {
  return encodeURIComponent(value).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `?a=b&c=d`, or nothing at all when every choice is the default. */
export function queryFor(setup: Setup): string {
  const params = paramsFor(setup);
  return params.length
    ? `?${params.map(([k, v]) => `${k}=${encodeForSnippet(v)}`).join("&")}`
    : "";
}

/**
 * The same choices as attributes, for the one form that has a tag to put them
 * on — except `pre`, which the relay must read off the request itself.
 */
export function attrsFor(setup: Setup): string {
  return paramsFor(setup)
    .filter(([k]) => k !== "pre")
    // The key is already on the src when the pre-payload is asked for, since
    // the relay has to read it off the request; twice would just be noise in
    // something someone has to paste by hand.
    .filter(([k]) => !(k === "key" && setup.pre))
    .map(([k, v]) => ` data-${k}="${escapeAttr(v)}"`)
    .join("");
}

/**
 * What a script tag puts on its `src`.
 *
 * `pre` has to be here because the relay reads it off the request to know to
 * send the script, and it never sees a data attribute. The key goes with it
 * when `pre` is asked for, for the same reason: the relay has to know which
 * project's script to send, and `data-key` is invisible to it. Otherwise the
 * key travels as `data-key` like every other choice, where it is not sitting
 * in a URL that ends up in access logs and `Referer` headers.
 */
export function srcQueryFor(setup: Setup): string {
  if (!setup.pre) return "";
  return setup.key ? `?pre=1&key=${encodeForSnippet(setup.key)}` : "?pre=1";
}

/** A session name is free text, and it is being pasted into markup. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Every way of putting the agent into a page, built from one set of choices. */
export function snippetsFor(
  setup: Setup,
  origin: string,
): Array<{ id: string; title: string; hint: string; code: string }> {
  const q = queryFor(setup);
  // Everything but the script tag loads the file by URL, so they all share the
  // same two lines of DOM work; spelling it once keeps them comparable.
  const load = `var s=document.createElement('script');s.src='${origin}/agent.js${q}';document.head.appendChild(s)`;
  return [
    {
      id: "script",
      title: "Script tag",
      hint: "In the page’s <head>, before its own scripts.",
      code: `<script src="${origin}/agent.js${srcQueryFor(setup)}"${attrsFor(setup)}></script>`,
    },
    {
      id: "img",
      title: "Img tag",
      hint: "For a field that takes HTML but strips <script>. It runs from an inline handler, so it gets past a sanitiser, never past a CSP.",
      code: `<img src="x" onerror="${load}">`,
    },
    {
      id: "import",
      title: "Import call",
      hint: "In the page’s own devtools console, or anywhere the page runs code.",
      code: `import("${origin}/agent.js${q}")`,
    },
    {
      id: "fetch",
      title: "Fetch call",
      hint: "Where a console refuses import(): one expression, no module policy to satisfy.",
      code: `fetch("${origin}/agent.js${q}").then(r=>r.text()).then(eval)`,
    },
    {
      id: "bookmarklet",
      title: "Bookmarklet",
      hint: "Save as a bookmark’s URL, then click it on the page you want to debug.",
      code: `javascript:(function(){${load}})()`,
    },
  ];
}
