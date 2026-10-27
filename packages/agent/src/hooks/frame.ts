/**
 * Hosting the page inside an iframe, so a navigation does not end the run.
 *
 * Nothing inside a document can survive that document being replaced. The way
 * round it is to put the app one level down: the top window holds a full-page
 * iframe and nothing else, and re-installs the agent into that frame after
 * every navigation it makes. The run then spans the whole flow instead of
 * stopping at the first link.
 *
 * The top window is a supervisor, not a participant — no socket, no hooks, no
 * session of its own. An empty wrapper reporting itself as a window of the run
 * would show up in the console as a blank tab nobody asked for.
 *
 * This changes the page it is debugging, which is worth being plain about:
 *
 *   - `window.top` is no longer the app, so frame-busting code will undo this,
 *     and anything keyed on being the top window behaves differently.
 *   - the address bar keeps the first URL however far the app navigates, so a
 *     reload or a bookmark goes back to where the run started.
 *   - a page whose headers refuse framing cannot be hosted at all, and there
 *     is no way to find that out except by trying. So the original page is
 *     hidden rather than thrown away, and if the frame turns out to be
 *     blocked it is put back and the run carries on in this window — ending
 *     at the first navigation, which is far better than a blank screen. The
 *     Webhook tab reads those headers up front, for anyone who would rather
 *     know before they start.
 */
import type { AgentConfig } from '../config';
import { flagName, getFlag, getHandle, setFlag } from '../mark';
import { adoptChildren, adoptOpeners, askOpenerToWatch, watchWindow } from './adopt';

/**
 * The frame's name, so the document inside it can tell where it is.
 *
 * A function, not a constant: a constant is evaluated at import time, which
 * is before boot has read the configured mark.
 */
export const frameName = (): string => flagName('_app');

/**
 * Take the window over, if this is the window to take over.
 *
 * Returns true when it did, and the caller must then install nothing else:
 * this document is now scaffolding, and its console, network and DOM are not
 * the page's.
 */
/**
 * Take the window over, if this is the window to take over.
 *
 * Returns true when it did, and the caller must then install nothing else:
 * this document is now scaffolding, and its console, network and DOM are not
 * the page's. `carryOn` is called instead if the frame turns out to be
 * blocked, by which time the page has been put back as it was.
 */
export function hostInIframe(config: AgentConfig, sessionId: string, carryOn: () => void): boolean {
  if (config.frame !== 'host') return false;
  // Only the outermost window wraps. A document already in a frame is either
  // the app we just put there or a frame the app made itself; wrapping again
  // would nest without end.
  try {
    if (window.top !== window.self) return false;
  } catch {
    return false; // cross-origin top: not ours to take over
  }
  /*
   * A second load of the script must not wrap the wrapper. The handle that
   * says "an agent is already here" is never set in this window — hosting
   * returns before that — so hosting keeps a flag of its own, through setFlag
   * like every other trace, so it is not enumerable either.
   */
  if (getFlag(window, 'Hosting')) return true;
  /*
   * And a flag named from the mark is no use against a snippet carrying a
   * different one. Two agents with two marks could not see each other's flag,
   * so the second wrapped the page a second time: it hid everything in the
   * body, which by then included the frame holding the first run, and put its
   * own frame up beside it. What that leaves is one page framed twice, the
   * first run still going behind `display:none` and recording a window
   * nobody can see. Two marks in one page may well have meant two runs; it
   * never meant that.
   *
   * So the second guard reads the arrangement itself rather than a name —
   * there is no name available here that is both mark-independent and not the
   * fixed token mark.ts exists to keep out of the page.
   */
  if (hostsOwnPage()) return true;
  setFlag(window, 'Hosting', true);

  /*
   * The snippet belongs in <head>, where there is no body yet.
   *
   * This used to give up at that point and return false, so the window
   * installed the ordinary agent instead and the option did nothing at all —
   * silently, and only when the snippet was placed exactly where the Agent
   * tab says to put it. Wait for the body instead.
   *
   * Returning true either way is the point: this window is scaffolding from
   * here on, and the events of a document we are about to replace are not
   * part of the run.
   */
  const start = () => wrap(config, sessionId, () => {
    setFlag(window, 'Hosting', false);
    carryOn();
  });
  if (document.body) start();
  else whenBodyExists(start);

  /*
   * The supervisor installs no hooks — but it still has to adopt the windows
   * opened from it.
   *
   * Everything the page does happens inside the frame, where `window.open` is
   * patched, so the page's own popups were never the problem. The operator's
   * own commands were: a devtools console defaults to the top frame, which is
   * this one, so `window.open("/")` typed there went through an unpatched
   * function and the new window left the run with nothing to say why.
   *
   * `adoptChildren` is all that is needed and no more. Its click interceptor
   * finds nothing here, because this document holds one iframe and no links.
   */
  if (config.adopt) {
    adoptChildren(config, sessionId);
    /*
     * Upwards is the supervisor's job too, and for a sharper reason: an
     * iframe has no opener. The agent that runs the ordinary boot lives
     * inside the frame, where `window.opener` is null, so a run that reached
     * C through A -> B -> C could not climb one step. The window holding that
     * chain is this one.
     *
     * Asking the opener to watch us matters as much. The window above booted
     * before we existed, so its own `window.open` hook never saw us, and
     * without this our next navigation would drop the agent for good.
     */
    adoptOpeners(config, sessionId);
    askOpenerToWatch();
  }
  return true;
}

/**
 * Whether this window is already holding a frame of its own page.
 *
 * That is what hosting looks like from the outside, and it stays that way:
 * the wrapper's body holds an iframe whose `src` is the wrapper's own URL,
 * and the attribute is not what moves when the app inside navigates. A page
 * that framed itself at exactly its own address would recurse without any
 * help from us, so there is no working document this mistakes for a wrapper.
 *
 * Direct children of <body> only. A frame further down belongs to the app.
 */
export function hostsOwnPage(): boolean {
  try {
    for (const el of Array.from(document.body?.children ?? [])) {
      if (el.tagName === 'IFRAME' && (el as HTMLIFrameElement).src === location.href) return true;
    }
  } catch {
    // No body yet, or a document that will not be read. Either way, nothing found.
  }
  return false;
}

/**
 * Call back the moment <body> appears, which is as early as a wrapper can
 * act — sooner than DOMContentLoaded, so less of a document we are about to
 * hide gets built. The load event is only a backstop for a document that
 * somehow never gets one.
 */
function whenBodyExists(run: () => void): void {
  let done = false;
  const once = () => {
    if (done || !document.body) return;
    done = true;
    observer.disconnect();
    document.removeEventListener('DOMContentLoaded', once);
    run();
  };
  const observer = new MutationObserver(once);
  observer.observe(document.documentElement, { childList: true });
  document.addEventListener('DOMContentLoaded', once);
  once(); // in case it arrived between the check and the observer
}

/** How long to let an agent come up inside the frame before giving the page back. */
const FRAME_TIMEOUT_MS = 8000;

function wrap(config: AgentConfig, sessionId: string, giveUp: () => void): void {
  /*
   * Asked again, because the check in hostInIframe may have run before <body>
   * existed — the Agent tab tells people to put the snippet in <head>, and an
   * empty document holds no wrapper to find. By now the other agent's frame
   * is in place. Returning leaves this window inert, which is what it is.
   */
  if (hostsOwnPage()) return;

  const url = location.href;
  const doc = document;

  /*
   * The page's own margins, written straight onto the two elements.
   *
   * This used to be a <style> element, which a page with a strict `style-src`
   * refuses: the stylesheet is dropped and nothing says so except a CSP
   * report. The frame still filled the viewport — an element's own `style` is
   * applied where a stylesheet is not — so what was left was the body's 8px
   * margin around it, a scrollbar on each axis from the 16px of overflow, and
   * a violation report sent to whoever collects them. A visible border and a
   * line in the target's security log is not a quiet way to sit in a page.
   *
   * Setting the properties individually is allowed under the same policy, so
   * this works where the stylesheet did not and is no louder where both do.
   */
  const reset: Array<{ el: HTMLElement; css: string }> = [];
  for (const el of [doc.documentElement, doc.body]) {
    if (!(el instanceof HTMLElement)) continue;
    reset.push({ el, css: el.style.cssText });
    el.style.margin = '0';
    el.style.padding = '0';
    el.style.height = '100%';
    el.style.overflow = 'hidden';
  }

  /*
   * Hide what the page had drawn rather than deleting it.
   *
   * It used to be cleared outright, on the grounds that the copy inside the
   * frame owns it now. That is true right up until the frame is refused, and
   * then the original is gone and there is nothing to show — which is what a
   * page sending X-Frame-Options looked like: a blank window and an error in
   * a console nobody was reading.
   */
  const hidden: Array<{ el: HTMLElement; display: string }> = [];
  for (const child of Array.from(doc.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    hidden.push({ el: child, display: child.style.display });
    child.style.display = 'none';
  }

  const frame = doc.createElement('iframe');
  frame.name = frameName();
  // No title attribute. It used to say "the page being debugged", which put a
  // plain-English description of what was happening into the accessibility
  // tree of a page whose owner had not been told.
  frame.style.cssText = 'display:block;border:0;width:100vw;height:100vh';
  doc.body.appendChild(frame);
  frame.src = url;

  let settled = false;
  let stopWatching: () => void = () => undefined;
  const stopTimers = () => {
    clearTimeout(timer);
    clearInterval(probe);
  };
  const restore = () => {
    if (settled) return;
    settled = true;
    stopTimers();
    stopWatching();
    frame.remove();
    for (const { el, css } of reset) el.style.cssText = css;
    for (const { el, display } of hidden) el.style.display = display;
    giveUp();
  };
  const keep = () => {
    if (settled) return;
    settled = true;
    stopTimers();
  };

  /*
   * Hosting has worked only once an agent is actually running inside the
   * frame — not merely once the frame has loaded.
   *
   * The frame loading was the test this used to settle on, and it is not
   * enough. watchWindow below injects the agent into the frame, but that can
   * come to nothing and still leave a loaded page: a CSP that blocks the
   * agent's own script, a document that holds the app but never re-runs an
   * injected payload, a relay that cannot be reached from in there. Each of
   * those is a framed page recording nothing, and settling on "loaded" left
   * it there — a run with no session and no way back. So the signal is the
   * agent's handle appearing on the framed window, which is same-origin and
   * so readable; until it does, the window is still ours to hand back.
   */
  const probe = setInterval(() => {
    try {
      if (frame.contentWindow && getHandle(frame.contentWindow)) keep();
    } catch {
      // A frame the browser refused sits on an opaque origin and throws here;
      // the load handler and the timeout below are what deal with that.
    }
  }, 150);

  // A refused frame never gets an agent, so give the page back the moment the
  // load event shows it was blocked rather than waiting the timeout out.
  frame.addEventListener('load', () => {
    if (!framedOk(frame)) restore();
  });
  /*
   * The backstop for every other way hosting comes to nothing: a frame that
   * loaded but booted no agent, or one that never fires load at all. Handing
   * the window back here is what keeps a hosting failure from costing the
   * session — the run carries on in this window, ending at the first
   * navigation, which is far better than nothing recorded at all.
   */
  const timer = setTimeout(restore, FRAME_TIMEOUT_MS);

  // The agent goes in as soon as the frame has a document, and again after
  // every navigation it makes — which is the entire point of the arrangement.
  stopWatching = watchWindow(frame.contentWindow, config, sessionId);
}

/** Whether the frame is holding our page rather than the browser's refusal. */
function framedOk(frame: HTMLIFrameElement): boolean {
  try {
    const doc = frame.contentDocument;
    if (!doc) return false;
    // Chrome renders a blocked frame as an error page on an opaque origin;
    // reading it throws, or gives back a document that is not ours.
    return doc.location.href !== 'about:blank' || Boolean(doc.body?.children.length);
  } catch {
    return false;
  }
}
