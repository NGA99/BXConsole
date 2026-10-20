/**
 * Rebuilds the remote document inside a script-less iframe and applies
 * streamed ops by node id. Pure DOM, no React: this runs per mutation batch.
 */
import { assetPath, isProxyableUrl, rewriteCssUrls, rewriteSrcset, type ScreenOp, type SnapshotNode } from '@bxconsole/protocol';

// Nodes live in the iframe's realm, so `instanceof Element` from this window is
// always false. Use nodeType / tagName checks everywhere below.
const isElement = (n: Node | undefined | null): n is Element => !!n && n.nodeType === 1;
const tagOf = (n: Node): string => (isElement(n) ? n.tagName.toUpperCase() : '');

/**
 * Attributes that make the browser go and fetch something, by tag.
 *
 * Everything listed here is routed through the relay's asset proxy, so the
 * bytes come from the debugged page's own browser. Anything not listed keeps
 * its original URL and is left to the `<base>` fallback — which is the right
 * answer for a public CDN file the page could not read anyway (no CORS), and
 * a broken image for an intranet one. `<a href>` is deliberately absent: it is
 * a destination, not a subresource.
 */
const URL_ATTRS: Record<string, readonly string[]> = {
  IMG: ['src', 'srcset'],
  SOURCE: ['src', 'srcset'],
  VIDEO: ['src', 'poster'],
  AUDIO: ['src'],
  TRACK: ['src'],
  INPUT: ['src'],
  LINK: ['href'],
  OBJECT: ['data'],
  EMBED: ['src'],
  IMAGE: ['href', 'xlink:href'],
  USE: ['href', 'xlink:href'],
};
/** `<link>` is only a subresource for some values of rel. */
const FETCHING_REL = /\b(stylesheet|icon|apple-touch-icon|mask-icon)\b/i;

export class DomMirror {
  private readonly nodes = new Map<number, Node>();
  private readonly idsOf = new Map<Node, number>();
  private readonly doc: Document;
  /** when false, remote scroll positions are ignored so the viewer can scroll the mirror on its own */
  followScroll = true;

  /** where the mirrored document lives, for resolving its relative URLs */
  private baseUrl = location.href;

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly sessionId: string,
    /** the window this mirror is showing, so its own files are fetched by it */
    private readonly tabId?: string,
  ) {
    this.doc = frame.contentDocument!;
  }

  /** Replace the whole document with a snapshot. */
  load(snapshot: SnapshotNode[], baseUrl: string): void {
    this.baseUrl = baseUrl || location.href;
    this.nodes.clear();
    this.idsOf.clear();
    const doc = this.doc;
    // Reset to a clean document.
    doc.open();
    doc.write('<!doctype html><html><head></head><body></body></html>');
    doc.close();

    for (const n of snapshot) {
      if (n.t !== 'el') continue; // doctype already written
      const html = this.build(n);
      doc.replaceChild(html, doc.documentElement);
    }
    const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild);
    const base = doc.createElement('base');
    base.href = baseUrl;
    head.insertBefore(base, head.firstChild);
    this.injectViewerStyle(head);
  }

  /**
   * Empty the mirror.
   *
   * Pointing the console at another window does not fetch that window's frame
   * instantly, and a window that recorded nothing never sends one at all — so
   * the document has to be blanked rather than waited out. Without this the
   * window just left stayed on screen under the new window's name, which read
   * as two windows showing the same page.
   */
  clear(): void {
    this.nodes.clear();
    this.idsOf.clear();
    const doc = this.doc;
    doc.open();
    doc.write('<!doctype html><html><head></head><body></body></html>');
    doc.close();
  }

  /** Draw a focus ring on the remote document's active element. */
  setFocus(id: number | null): void {
    this.doc.querySelectorAll('[data-bsc-focus]').forEach((el) => el.removeAttribute('data-bsc-focus'));
    const el = id === null ? undefined : this.nodes.get(id);
    if (isElement(el)) el.setAttribute('data-bsc-focus', '');
  }

  /** Bounding box of a mirrored node in the iframe's viewport, for placing the remote cursor. */
  rectOf(id: number): DOMRect | null {
    const n = this.nodes.get(id);
    if (!isElement(n)) return null;
    const r = n.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  /** Mirrored element under a viewport point, with the remote node id (walks up past unmapped nodes). */
  elementAt(x: number, y: number): { id: number | null; tag: string; label: string; rect: DOMRect | null } | null {
    const el = this.doc.elementFromPoint(x, y);
    if (!el) return null;
    for (let n: Node | null = el; n; n = n.parentNode) {
      const id = this.idsOf.get(n);
      if (id !== undefined) return { id, tag: tagOf(n).toLowerCase(), label: selectorLabel(n as Element), rect: (n as Element).getBoundingClientRect() };
    }
    return { id: null, tag: tagOf(el).toLowerCase(), label: selectorLabel(el), rect: el.getBoundingClientRect() };
  }

  apply(ops: ScreenOp[]): { unknownIds: number } {
    let unknown = 0;
    for (const op of ops) {
      switch (op.op) {
        case 'add': {
          const parent = this.nodes.get(op.parentId);
          if (!parent) {
            unknown++;
            break;
          }
          const next = op.nextId === null ? null : this.nodes.get(op.nextId) ?? null;
          parent.insertBefore(this.build(op.node), next);
          break;
        }
        case 'remove': {
          const n = this.nodes.get(op.id);
          if (!n) break;
          n.parentNode?.removeChild(n);
          this.forget(n);
          break;
        }
        case 'attr': {
          const el = this.nodes.get(op.id);
          if (!isElement(el)) break;
          this.setAttr(el, op.name, op.value === null ? null : this.proxyAttrValue(el, op.name, op.value));
          // Whether a <link> fetches anything depends on its rel, so an href
          // set while rel was still something else was left unproxied.
          if (tagOf(el) === 'LINK' && op.name.toLowerCase() === 'rel') this.proxySubresources(el);
          break;
        }
        case 'text': {
          const n = this.nodes.get(op.id);
          if (n) n.nodeValue = this.cssIfStyle(n, op.text);
          break;
        }
        case 'input': {
          const el = this.nodes.get(op.id);
          if (!el) break;
          this.applyInput(el, op.value, op.checked);
          break;
        }
        case 'scroll': {
          if (!this.followScroll) break;
          if (op.id === null) this.frame.contentWindow?.scrollTo(op.x, op.y);
          else {
            const el = this.nodes.get(op.id);
            if (isElement(el)) {
              el.scrollLeft = op.x;
              el.scrollTop = op.y;
            }
          }
          break;
        }
        case 'viewport':
          break; // handled by the panel (frame size)
        case 'focus':
          this.setFocus(op.id);
          break;
      }
    }
    return { unknownIds: unknown };
  }

  // ------------------------------------------------------------------ build

  private build(node: SnapshotNode): Node {
    const doc = this.doc;
    let out: Node;
    switch (node.t) {
      case 'tx':
        out = doc.createTextNode(node.text);
        break;
      case 'cm':
        out = doc.createComment(node.text);
        break;
      case 'doctype':
        out = doc.createComment(`doctype ${node.name}`);
        break;
      case 'el': {
        // Nested frames would be sandboxed about:blank documents that only produce console noise;
        // links that trigger fetches from this origin (manifest, preload…) are pointless here.
        if (node.tag === 'iframe' || node.tag === 'frame') {
          const box = doc.createElement('div');
          box.className = 'bsc-frame-placeholder';
          box.textContent = `<${node.tag}${node.attrs.src ? ` ${node.attrs.src}` : ''}>`;
          for (const k of ['width', 'height', 'style', 'class', 'id'] as const) if (node.attrs[k]) box.setAttribute(k === 'class' ? 'data-class' : k, node.attrs[k]!);
          this.nodes.set(node.id, box);
          this.idsOf.set(box, node.id);
          return box;
        }
        if (node.tag === 'link' && /^(manifest|preload|modulepreload|prefetch|prerender|dns-prefetch|preconnect)$/i.test(node.attrs.rel ?? '')) {
          const stub = doc.createComment(`link rel=${node.attrs.rel}`);
          this.nodes.set(node.id, stub);
          this.idsOf.set(stub, node.id);
          return stub;
        }
        const el = node.ns ? doc.createElementNS(node.ns, node.tag) : doc.createElement(node.tag);
        for (const [k, v] of Object.entries(node.attrs)) this.setAttr(el, k, v);
        // After the whole set, not per attribute: whether a <link> fetches
        // anything depends on its rel, which may arrive after its href.
        this.proxySubresources(el);
        for (const c of node.children) el.appendChild(this.build(c));
        // In place, through the text node: assigning textContent would replace
        // the node and lose the id the stream keeps addressing it by.
        if (tagOf(el) === 'STYLE') {
          for (const c of Array.from(el.childNodes)) if (c.nodeType === 3 && c.nodeValue) c.nodeValue = this.proxyCss(c.nodeValue);
        }
        if (node.attrs['data-bsc-value'] !== undefined || node.attrs['data-bsc-checked'] !== undefined) {
          const checked = node.attrs['data-bsc-checked'];
          this.applyInput(el, node.attrs['data-bsc-value'], checked === undefined ? undefined : checked === 'true');
        }
        out = el;
        break;
      }
    }
    this.nodes.set(node.id, out);
    this.idsOf.set(out, node.id);
    return out;
  }

  // ------------------------------------------------- fetching through the page

  /**
   * Turn one URL from the mirrored document into a relay asset URL.
   *
   * Absolute on purpose: the mirror keeps a `<base href>` pointing at the real
   * page, so a root-relative "/asset/..." would resolve against the debugged
   * origin instead of the relay. Returns null when the value should be left
   * exactly as it was.
   */
  private proxy(raw: string): string | null {
    if (!isProxyableUrl(raw)) return null;
    // Already ours: an attribute re-set with the same value must not be wrapped twice.
    if (raw.startsWith(`${location.origin}/asset/`)) return null;
    try {
      const abs = new URL(raw, this.baseUrl).href;
      if (!/^(https?|blob):/i.test(abs)) return null;
      return new URL(assetPath(this.sessionId, abs, this.tabId ? { tabId: this.tabId } : undefined), location.origin).href;
    } catch {
      return null;
    }
  }

  private proxyCss(css: string): string {
    // Most style attributes and most rules reference nothing. This runs over
    // every one of them on every snapshot, so the cheap test comes first.
    if (!/url\(|@import/i.test(css)) return css;
    return rewriteCssUrls(css, this.baseUrl, (abs) => this.proxy(abs));
  }

  /** The same rewrite for a text node, but only when it is a stylesheet's body. */
  private cssIfStyle(node: Node, text: string): string {
    return tagOf(node.parentNode as Node) === 'STYLE' ? this.proxyCss(text) : text;
  }

  /** Rewrite every subresource URL an element carries, once its attributes are all set. */
  private proxySubresources(el: Element): void {
    for (const attr of Array.from(el.attributes)) {
      const next = this.proxyAttrValue(el, attr.name, attr.value);
      if (next !== attr.value) this.setAttr(el, attr.name, next);
    }
  }

  /** The value an attribute should hold in the mirror; unchanged when it names nothing fetchable. */
  private proxyAttrValue(el: Element, name: string, value: string): string {
    const lower = name.toLowerCase();
    if (lower === 'style') return this.proxyCss(value);
    const tag = tagOf(el);
    if (tag === 'LINK' && !FETCHING_REL.test(el.getAttribute('rel') ?? '')) return value;
    if (!URL_ATTRS[tag]?.includes(lower)) return value;
    if (lower === 'srcset') return rewriteSrcset(value, (raw) => this.proxy(raw));
    return this.proxy(value) ?? value;
  }

  private setAttr(el: Element, name: string, value: string | null): void {
    if (value === null) {
      el.removeAttribute(name);
      return;
    }
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) return;
    if ((lower === 'href' || lower === 'src' || lower === 'action') && /^\s*javascript:/i.test(value)) return;
    if (tagOf(el) === 'IFRAME' && (lower === 'src' || lower === 'srcdoc')) return;
    try {
      el.setAttribute(name, value);
    } catch {
      /* invalid attribute name from the remote page */
    }
  }

  private applyInput(el: Node, value: string | undefined, checked: boolean | undefined): void {
    const tag = tagOf(el);
    if (tag === 'INPUT') {
      const input = el as HTMLInputElement;
      if (checked !== undefined) input.checked = checked;
      if (value !== undefined) input.value = value;
    } else if (tag === 'TEXTAREA' || tag === 'SELECT') {
      if (value !== undefined) (el as HTMLTextAreaElement | HTMLSelectElement).value = value;
    }
  }

  private forget(n: Node): void {
    // ids are unique per node, so a linear scan on remove is acceptable for a prototype
    for (const [id, node] of this.nodes) {
      if (node === n || n.contains(node)) {
        this.nodes.delete(id);
        this.idsOf.delete(node);
      }
    }
  }

  private injectViewerStyle(head: HTMLElement): void {
    const style = this.doc.createElement('style');
    style.setAttribute('data-bsc-viewer', '');
    // Input is captured by the panel's overlay, so the mirror itself never reacts; keep selection off too.
    style.textContent =
      'html { user-select: none !important; cursor: default !important; }' +
      '[data-bsc-focus] { outline: 2px solid #1a73e8 !important; outline-offset: 1px !important; }' +
      '.bsc-frame-placeholder { display: inline-block; min-width: 120px; min-height: 40px; border: 1px dashed #9aa0a6; color: #9aa0a6; font: 11px monospace; padding: 4px; box-sizing: border-box; }';
    head.appendChild(style);
  }
}

/** `div#app.main.dark`, as DevTools shows in its inspect tooltip. */
function selectorLabel(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}
