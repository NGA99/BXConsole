/**
 * Screen streaming: serialise the document, then stream mutations.
 *
 * Streaming normally runs only while someone has the Screen tab open (the
 * relay sends `screen.start` / `screen.stop`). With `data-screen="record"` the
 * page streams from boot and ignores `screen.stop`, so the relay has a
 * recording to time-travel through even when nobody was watching — see the
 * README on what that costs.
 *
 * Node identity is a WeakMap<Node, id>; ids are assigned during
 * serialisation and reused for every later op, so the viewer can mirror the
 * tree without ever seeing a live Node. Scripts are dropped (the viewer
 * iframe runs none), <noscript> too (it would render there), iframes are
 * kept as empty boxes, and <style> text is read from `sheet.cssRules` so
 * CSS-in-JS rules inserted via insertRule() are captured.
 *
 * Click-through: the viewer sends `screen.input` with the mirrored node id and
 * viewport point; we synthesise pointer/mouse/click events on the real node.
 * The remote cursor is sent once per frame from mousemove.
 *
 * Keyboard: `screen.input` kind `key` / `paste` is replayed on
 * document.activeElement with default actions emulated (see screen-keys.ts).
 *
 * TODO: canvas (toDataURL), shadow DOM, adoptedStyleSheets, media playback
 *       state, drag, IME composition.
 */
import type { ScreenInput, ScreenOp, ScreenSnapshot, SnapshotNode } from '@bxconsole/protocol';
import type { Transport } from '../transport';
import { applyKey, applyPaste } from './screen-keys';

const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT']);

const ids = new WeakMap<Node, number>();
/** reverse lookup for click-through; WeakRef so removed nodes can be collected */
/**
 * Lets a command name a node by id. The WeakRef frees the node, but the entry
 * itself has to be dropped by hand, and a DOM-churning page creates nodes
 * without limit: a virtualised list left open for a few minutes used to add
 * hundreds of thousands of permanent entries inside the page.
 */
const byId = new Map<number, WeakRef<Node>>();

/** Drop entries whose node is gone; cheap, and only when the map has grown. */
function pruneIds(): void {
  if (byId.size < 5000) return;
  for (const [id, ref] of byId) if (!ref.deref()) byId.delete(id);
}
let nextId = 1;

// remote cursor, sent at most once per frame
type Anchor = { id: number; fx: number; fy: number; dx: number; dy: number; w: number; h: number };
let cursor: { x: number; y: number; visible: boolean; pressed: boolean; anchor: Anchor | null } = {
  x: 0,
  y: 0,
  visible: false,
  pressed: false,
  anchor: null,
};
let cursorDirty = false;

let active = false;
/** record continuously, whether or not a viewer is attached */
let alwaysOn = false;
let observer: MutationObserver | null = null;
let pending: ScreenOp[] = [];
let flushScheduled = false;
let cleanup: Array<() => void> = [];
let transportRef: Transport | null = null;

/** Screen node id of a live node, if the mirror has seen it (streaming must be on). */
export function screenIdOf(node: Node): number | undefined {
  return active ? ids.get(node) : undefined;
}

/** Live node for a screen node id (ids are assigned while streaming). */
export function nodeByScreenId(id: number): Node | undefined {
  const n = byId.get(id)?.deref();
  return n && n.isConnected ? n : undefined;
}

export function startScreen(transport: Transport): void {
  stopScreen(false);
  transportRef = transport;
  active = true;

  transport.send(snapshot());

  observer = new MutationObserver(onMutations);
  observer.observe(document, { childList: true, attributes: true, characterData: true, subtree: true });

  const onScroll = (e: Event) => {
    const target = e.target;
    if (target === document) queue({ op: 'scroll', id: null, x: window.scrollX, y: window.scrollY });
    else if (target instanceof Element && ids.has(target)) {
      queue({ op: 'scroll', id: ids.get(target)!, x: target.scrollLeft, y: target.scrollTop });
    }
  };
  const onInput = (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
    if (!ids.has(t)) return;
    queue({ op: 'input', id: ids.get(t)!, ...inputState(t) });
  };
  const onResize = () => queue({ op: 'viewport', width: window.innerWidth, height: window.innerHeight });

  const onMove = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY, visible: true, anchor: anchorOf(e) });
  const onDown = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY, visible: true, pressed: true, anchor: anchorOf(e) });
  const onUp = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY, visible: true, pressed: false, anchor: anchorOf(e) });
  const onLeave = () => setCursor({ visible: false, pressed: false });
  const onFocus = () => queue({ op: 'focus', id: focusedId() });

  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('input', onInput, { capture: true });
  document.addEventListener('change', onInput, { capture: true });
  window.addEventListener('resize', onResize);
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.addEventListener('mousedown', onDown, { capture: true, passive: true });
  document.addEventListener('mouseup', onUp, { capture: true, passive: true });
  document.documentElement.addEventListener('mouseleave', onLeave);
  document.addEventListener('focusin', onFocus, { capture: true });
  document.addEventListener('focusout', onFocus, { capture: true });
  cleanup = [
    () => document.removeEventListener('focusin', onFocus, { capture: true }),
    () => document.removeEventListener('focusout', onFocus, { capture: true }),
    () => document.removeEventListener('scroll', onScroll, { capture: true }),
    () => document.removeEventListener('input', onInput, { capture: true }),
    () => document.removeEventListener('change', onInput, { capture: true }),
    () => window.removeEventListener('resize', onResize),
    () => document.removeEventListener('mousemove', onMove, { capture: true }),
    () => document.removeEventListener('mousedown', onDown, { capture: true }),
    () => document.removeEventListener('mouseup', onUp, { capture: true }),
    () => document.documentElement.removeEventListener('mouseleave', onLeave),
  ];
}

/** Click / wheel coming back from a viewer. Resolves the node by id, else by viewport point. */
let hoverTarget: Element | null = null;

export function handleScreenInput(input: ScreenInput): void {
  if (input.kind === 'move') {
    const target = resolveTarget(input.id, input.x, input.y);
    if (!target) return;
    const { x, y } = pointOn(target, input);
    const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
    if (target !== hoverTarget) {
      hoverTarget?.dispatchEvent(new MouseEvent('mouseout', { ...init, relatedTarget: target }));
      target.dispatchEvent(new MouseEvent('mouseover', { ...init, relatedTarget: hoverTarget }));
      hoverTarget = target;
    }
    target.dispatchEvent(new MouseEvent('mousemove', init));
    setCursor({ x, y, visible: true, anchor: anchorFor(target, x, y) });
    queueMicrotask(flush);
    return;
  }
  if (input.kind === 'key') {
    applyKey(input);
    queueMicrotask(flush);
    return;
  }
  if (input.kind === 'paste') {
    applyPaste(input.text);
    queueMicrotask(flush);
    return;
  }

  const target = resolveTarget(input.id, input.x, input.y);
  if (!target) return;

  if (input.kind === 'click') {
    const { x: cx, y: cy } = pointOn(target, input);
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: input.button,
      buttons: input.button === 0 ? 1 : input.button === 2 ? 2 : 4,
      detail: input.detail,
    };
    const pointerInit: PointerEventInit = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const fire = (type: string, Ctor: typeof MouseEvent | typeof PointerEvent, i: MouseEventInit) =>
      target.dispatchEvent(new Ctor(type, i));

    const PE = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    fire('pointerdown', PE, pointerInit);
    fire('mousedown', MouseEvent, init);
    focusTarget(target);
    fire('pointerup', PE, { ...pointerInit, buttons: 0 });
    fire('mouseup', MouseEvent, { ...init, buttons: 0 });
    if (input.button === 0) fire('click', MouseEvent, { ...init, buttons: 0 });
    else if (input.button === 2) fire('contextmenu', MouseEvent, { ...init, buttons: 0 });
    if (input.detail === 2) fire('dblclick', MouseEvent, { ...init, buttons: 0 });
    // Echo the click as a cursor press so other viewers see it too.
    setCursor({ x: cx, y: cy, visible: true, pressed: true, anchor: anchorFor(target, cx, cy) });
    setTimeout(() => setCursor({ pressed: false }), 120);
  } else if (input.kind === 'wheel') {
    const scroller = scrollableAncestor(target);
    if (scroller) scroller.scrollBy({ left: input.deltaX, top: input.deltaY });
    else window.scrollBy({ left: input.deltaX, top: input.deltaY });
  }

  // MutationObserver delivers in a microtask queued by the first mutation above,
  // so a microtask queued now runs after it: flush the resulting ops right away
  // instead of waiting for the (background-throttled) timer.
  queueMicrotask(flush);
}

/** focusout fires before the next focusin; read activeElement after the microtask so we report the final state. */
function focusedId(): number | null {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return ids.get(el) ?? null;
}

function resolveTarget(id: number | null, x: number, y: number): Element | null {
  if (id !== null) {
    const n = byId.get(id)?.deref();
    if (n && n.isConnected) return n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
  }
  return document.elementFromPoint(x, y);
}

function focusTarget(target: Element): void {
  const focusable = target.closest<HTMLElement>('input, textarea, select, button, a[href], [tabindex], [contenteditable]');
  if (focusable) focusable.focus({ preventScroll: true });
  else (document.activeElement as HTMLElement | null)?.blur?.();
}

function scrollableAncestor(el: Element | null): Element | null {
  for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
    const { overflowY, overflowX } = getComputedStyle(e);
    const scrollsY = /(auto|scroll)/.test(overflowY) && e.scrollHeight > e.clientHeight;
    const scrollsX = /(auto|scroll)/.test(overflowX) && e.scrollWidth > e.clientWidth;
    if (scrollsY || scrollsX) return e;
  }
  return null;
}

/** Element under the pointer and the pointer's position inside its box, for reflowed mirrors. */
function anchorOf(e: MouseEvent): Anchor | null {
  const el = e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY);
  return el ? anchorFor(el, e.clientX, e.clientY) : null;
}

function anchorFor(el: Element, x: number, y: number): Anchor | null {
  const id = ids.get(el);
  if (id === undefined) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { id, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, dx: x - r.left, dy: y - r.top, w: r.width, h: r.height };
}

/** Viewer point -> page viewport point: by fraction inside the real element when given, else as sent. */
function pointOn(target: Element, input: { x: number; y: number; fx?: number; fy?: number }): { x: number; y: number } {
  if (input.fx === undefined || input.fy === undefined) return { x: input.x, y: input.y };
  const r = target.getBoundingClientRect();
  return { x: r.left + r.width * input.fx, y: r.top + r.height * input.fy };
}

function setCursor(patch: Partial<typeof cursor>): void {
  if (!active) return;
  cursor = { ...cursor, ...patch };
  cursorDirty = true;
  scheduleFlush();
}

/**
 * A keyframe for the relay's recording: the document as it is now, with the
 * same node ids, so the recording can be restored from here without replaying
 * everything before it. Pending mutations are drained first, so the keyframe
 * and the ops around it agree; the observer and the viewers are untouched.
 */
export function keyframeScreen(): void {
  if (!active || !transportRef) return;
  const records = observer?.takeRecords();
  if (records?.length) onMutations(records);
  flush();
  transportRef.send({ ...snapshot(), keyframe: true });
}

/** Keep streaming even when the last viewer closes its Screen tab. */
export function setScreenAlwaysOn(on: boolean): void {
  alwaysOn = on;
}

function snapshot(): ScreenSnapshot {
  return {
    type: 'screen.snapshot',
    ts: Date.now(),
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    focus: focusedId(),
    doc: Array.from(document.childNodes).map(serialize).filter((n): n is SnapshotNode => n !== null),
  };
}

export function stopScreen(notify = true): void {
  // While recording, the relay's stop (no viewers left) is ignored: the point
  // of recording is the stretch nobody was watching.
  if (notify && alwaysOn) return;
  if (!active) return;
  active = false;
  observer?.disconnect();
  observer = null;
  for (const fn of cleanup) fn();
  cleanup = [];
  pending = [];
  hoverTarget = null;
  byId.clear();
  if (notify) transportRef?.send({ type: 'screen.stopped', ts: Date.now() });
}

// ------------------------------------------------------------- serialisation

/** A stand-in id for a <style>'s rendered text when the tag has no text node. */
const syntheticIds = new WeakMap<Element, number>();
function syntheticTextId(el: Element): number {
  let id = syntheticIds.get(el);
  if (id === undefined) {
    id = nextId++;
    syntheticIds.set(el, id);
  }
  return id;
}

function idOf(node: Node): number;
function idOf(node: Node | null): number | undefined;
function idOf(node: Node | null): number | undefined {
  if (!node) return undefined;
  let id = ids.get(node);
  if (id === undefined) {
    id = nextId++;
    ids.set(node, id);
  }
  // Always, not only for a new id: `ids` survives a stop/start but `byId` is
  // cleared with the stream, and a node that keeps its id would otherwise
  // never be findable again — Elements, styles and click-through all look up
  // through this map.
  byId.set(id, new WeakRef(node));
  return id;
}

function serialize(node: Node): SnapshotNode | null {
  switch (node.nodeType) {
    case Node.DOCUMENT_TYPE_NODE:
      return { id: idOf(node), t: 'doctype', name: (node as DocumentType).name };
    case Node.TEXT_NODE:
      return { id: idOf(node), t: 'tx', text: node.nodeValue ?? '' };
    case Node.COMMENT_NODE:
      return { id: idOf(node), t: 'cm', text: node.nodeValue ?? '' };
    case Node.ELEMENT_NODE: {
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName)) return null;
      const attrs: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;

      const out: SnapshotNode = { id: idOf(el), t: 'el', tag: el.tagName.toLowerCase(), attrs, children: [] };
      if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') out.ns = el.namespaceURI;

      if (el instanceof HTMLStyleElement) {
        const css = cssText(el.sheet);
        if (css !== null) {
          // A <style> filled through insertRule (any CSS-in-JS) has no text
          // child to take an id from. Reusing the element's own id made the
          // viewer store a text node under it, as its own parent, and walking
          // up from there never ends.
          out.children = [{ id: idOf(el.firstChild) ?? syntheticTextId(el), t: 'tx', text: css }];
          return out;
        }
      }
      if (el instanceof HTMLIFrameElement) {
        delete attrs.src;
        delete attrs.srcdoc;
        return out;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const state = inputState(el);
        if (state.value !== undefined) attrs['data-bsc-value'] = state.value;
        if (state.checked !== undefined) attrs['data-bsc-checked'] = String(state.checked);
      }
      for (const child of Array.from(el.childNodes)) {
        const s = serialize(child);
        if (s) out.children.push(s);
      }
      return out;
    }
    default:
      return null;
  }
}

function cssText(sheet: CSSStyleSheet | null): string | null {
  if (!sheet) return null;
  try {
    return Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
  } catch {
    return null; // cross-origin
  }
}

/**
 * What an input is holding, as the recording sees it.
 *
 * Password fields included, and that is a choice rather than an oversight.
 * The whole run is a credential capture: the Authorization header a request
 * carried is kept, so is an object the page logged with a token inside it,
 * and seeing what passed through the page is the reason for watching it. A
 * password field replaced by bullets makes none of that safer. It blanks the
 * one place the person actually typed — which is where a replay is read most
 * closely — and leaves the operator unable to tell a mistyped login from a
 * rejected one.
 *
 * File inputs are skipped for a reason that does hold: `value` is a fake path
 * the browser invents, and the files themselves cannot be read from here, so
 * there is nothing true to put in the recording.
 *
 * Exported for its tests, which are the point: this used to bullet passwords
 * out, silently and with nothing covering it either way.
 */
export function inputState(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): { value?: string; checked?: boolean } {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return { checked: el.checked };
    if (el.type === 'file') return {};
  }
  return { value: el.value };
}

// ------------------------------------------------------------------ mutations

function onMutations(records: MutationRecord[]): void {
  const added = new Set<Node>();
  const removed = new Set<Node>();

  for (const r of records) {
    switch (r.type) {
      case 'attributes': {
        const el = r.target as Element;
        if (!ids.has(el) || !r.attributeName) break;
        queue({ op: 'attr', id: ids.get(el)!, name: r.attributeName, value: el.getAttribute(r.attributeName) });
        break;
      }
      case 'characterData': {
        if (!ids.has(r.target)) break;
        queue({ op: 'text', id: ids.get(r.target)!, text: r.target.nodeValue ?? '' });
        break;
      }
      case 'childList':
        r.removedNodes.forEach((n) => removed.add(n));
        r.addedNodes.forEach((n) => added.add(n));
        break;
    }
  }

  // Removes first. A node that was removed and re-added (moved) is removed then added.
  for (const n of removed) {
    if (!ids.has(n)) continue;
    if (n.isConnected && !added.has(n)) continue;
    const id = ids.get(n)!;
    queue({ op: 'remove', id });
    byId.delete(id);
  }
  pruneIds();

  // Adds: only connected nodes whose parent is already known; a new parent's
  // serialisation already includes its new children.
  const toAdd = Array.from(added).filter((n) => n.isConnected && n.parentNode && ids.has(n.parentNode) && !hasAddedAncestor(n, added));
  // Last sibling first. An add names the node it goes before, and the viewer
  // can only honour that if the node is already there. When a whole run of
  // siblings arrives or moves at once, forwards order points every add at a
  // sibling that does not exist yet, so each one lands at the end and the run
  // comes out reversed. Backwards, the anchor is always in place.
  toAdd.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1));
  for (const n of toAdd) {
    const node = serialize(n);
    if (!node) continue;
    let next: Node | null = n.nextSibling;
    while (next && (!ids.has(next) || (next instanceof Element && SKIP_TAGS.has(next.tagName)))) next = next.nextSibling;
    queue({ op: 'add', parentId: ids.get(n.parentNode!)!, nextId: next ? ids.get(next)! : null, node });
  }
}

function hasAddedAncestor(n: Node, added: Set<Node>): boolean {
  for (let p = n.parentNode; p; p = p.parentNode) if (added.has(p)) return true;
  return false;
}

function queue(op: ScreenOp): void {
  if (!active) return;
  pending.push(op);
  scheduleFlush();
}

// A timer, not requestAnimationFrame: the page being debugged is usually a
// background tab, where rAF never fires but timers still do (throttled).
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(flush, 16);
}

function flush(): void {
  flushScheduled = false;
  if (!active) return;
  if (pending.length) {
    const ops = pending;
    pending = [];
    transportRef?.send({ type: 'screen.mutations', ts: Date.now(), ops });
  }
  if (cursorDirty) {
    cursorDirty = false;
    transportRef?.send({ type: 'screen.cursor', ts: Date.now(), ...cursor });
  }
}
