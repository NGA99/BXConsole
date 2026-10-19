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
}

/** What the tab was last set up to hand out, so a reload does not undo it. */
export interface Setup extends Options {
  name: string;
}

/**
 * Every option on, which is also what the agent assumes when a snippet says
 * nothing. So a run with nothing turned off needs no parameters at all, and
 * the tab hands out a bare script tag.
 */
export const DEFAULTS: Setup = { name: 'my-app', record: true, bodies: true, adopt: true, frame: true, collect: true };
export const SETUP_KEY = 'bxconsole.agent.setup';

/**
 * Read the saved setup, falling back to the defaults for anything missing.
 *
 * Merged field by field on purpose: an option added after someone last used
 * the tab is absent from their stored object, and taking it as `false` would
 * silently turn off something that defaults to on.
 */
export function loadSetup(storage: Pick<Storage, 'getItem'> = localStorage): Setup {
  try {
    return { ...DEFAULTS, ...(JSON.parse(storage.getItem(SETUP_KEY) ?? '{}') as Partial<Setup>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSetup(setup: Setup, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(SETUP_KEY, JSON.stringify(setup));
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
  if (setup.name.trim()) out.push(['name', setup.name.trim()]);
  // Only the switches that are off: a parameter in the snippet should mean
  // "this run is not the usual one", so that reading it tells you what the
  // person chose rather than restating the defaults back at them.
  if (!setup.record) out.push(['screen', 'viewer']);
  if (!setup.bodies) out.push(['bodies', '0']);
  if (!setup.adopt) out.push(['adopt', '0']);
  if (!setup.collect) out.push(['collect', '0']);
  if (!setup.frame) out.push(['frame', 'off']);
  return out;
}

/** `?a=b&c=d`, or nothing at all when every choice is the default. */
export function queryFor(setup: Setup): string {
  const params = paramsFor(setup);
  return params.length ? `?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : '';
}

/** The same choices as attributes, for the one form that has a tag to put them on. */
export function attrsFor(setup: Setup): string {
  return paramsFor(setup)
    .map(([k, v]) => ` data-${k}="${escapeAttr(v)}"`)
    .join('');
}

/** A session name is free text, and it is being pasted into markup. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Every way of putting the agent into a page, built from one set of choices. */
export function snippetsFor(setup: Setup, origin: string): Array<{ id: string; title: string; hint: string; code: string }> {
  const q = queryFor(setup);
  // Everything but the script tag loads the file by URL, so they all share the
  // same two lines of DOM work; spelling it once keeps them comparable.
  const load = `var s=document.createElement('script');s.src='${origin}/agent.js${q}';document.head.appendChild(s)`;
  return [
    {
      id: 'script',
      title: 'Script tag',
      hint: 'In the page’s <head>, before its own scripts.',
      code: `<script src="${origin}/agent.js"${attrsFor(setup)}></script>`,
    },
    {
      id: 'img',
      title: 'Img tag',
      hint: 'For a field that takes HTML but strips <script>. It runs from an inline handler, so it gets past a sanitiser, never past a CSP.',
      code: `<img src="x" onerror="${load}">`,
    },
    {
      id: 'import',
      title: 'Import call',
      hint: 'In the page’s own devtools console, or anywhere the page runs code.',
      code: `import("${origin}/agent.js${q}")`,
    },
    {
      id: 'fetch',
      title: 'Fetch call',
      hint: 'The same thing where a console refuses import(): one expression, no module policy to satisfy.',
      code: `fetch("${origin}/agent.js${q}").then(r=>r.text()).then(eval)`,
    },
    {
      id: 'bookmarklet',
      title: 'Bookmarklet',
      hint: 'Save as a bookmark’s URL, then click it on the page you want to debug.',
      code: `javascript:(function(){${load}})()`,
    },
  ];
}
