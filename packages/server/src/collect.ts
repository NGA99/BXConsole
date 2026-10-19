/**
 * Fetching the page's own files while the page is still there to fetch them.
 *
 * The bytes behind a script or a stylesheet can only be had from the debugged
 * page: the relay has no route to an intranet host and no cookies for it. So
 * the window in which a file is obtainable is the run itself. Until now the
 * trigger was someone opening that file in the console, which is a race the
 * person usually loses — they look at the recording afterwards, and by then
 * the page is gone and the bytes are unrecoverable.
 *
 * This turns it round: the relay already sees a `network.resource` event for
 * every subresource the page loads, so it knows the URLs as they happen and
 * can pull them in the background while the window is open.
 *
 * What makes that safe is the one thing it refuses to do. The agent's resource
 * hook skips `fetch` and `xmlhttprequest` initiators, so nothing here can ever
 * name an API call — only files the browser loaded as a subresource, where a
 * second GET is a repeat of something the page did to itself. The relay never
 * re-issues a request the page made on purpose.
 *
 * Everything else is restraint: a few at a time, after the load has settled,
 * never the same URL twice, and never once the session's budget is gone.
 */
import type { AssetData } from '@bxconsole/protocol';
import { classify, type BlobStore } from './blobs';

/**
 * Extensions worth fetching eagerly.
 *
 * Code and markup only. Images and fonts are `cache` to the blob store — they
 * are needed to draw a past frame but never read, they are much larger, and
 * the Screen mirror already fetches the ones it needs when someone watches.
 * Spending a run's budget on pictures would cost it the code.
 *
 * Resource Timing carries no content type, so the first guess is the path;
 * `classify` makes the real decision once the bytes are here.
 */
const WANTED = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'json', 'map', 'wasm', 'xml', 'svg', 'vue', 'svelte']);

export interface CollectorOptions {
  /** How many fetches may be in flight across all sessions at once. */
  concurrency?: number;
  /**
   * How long to wait after the last resource before fetching anything.
   *
   * A page load reports thirty resources in a few hundred milliseconds. Going
   * after them immediately would have the relay competing with the page for
   * its own connections at the exact moment it is trying to render.
   */
  settleMs?: number;
  /** Most URLs to remember per session, so a long run cannot grow unbounded. */
  maxTracked?: number;
}

/** What a session has already been offered, so nothing is fetched twice. */
interface Tracked {
  /** urls queued, fetched, refused or failed — every one of them, once */
  seen: Set<string>;
  queue: string[];
  tabs: Map<string, string>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class AssetCollector {
  private readonly tracked = new Map<string, Tracked>();
  private inFlight = 0;
  private draining = false;
  /** resolvers waiting for the queues to empty, for tests and for shutdown */
  private readonly idleWaiters: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly settleMs: number;
  private readonly maxTracked: number;

  constructor(
    private readonly blobs: BlobStore,
    /** Ask a live window of the session to fetch a URL; null when none can. */
    private readonly fetchAsset: (sessionId: string, url: string, tabId?: string) => Promise<AssetData | null>,
    opts: CollectorOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 3;
    this.settleMs = opts.settleMs ?? 1500;
    this.maxTracked = opts.maxTracked ?? 2000;
  }

  /**
   * A window loaded something. Take it or leave it — the caller does not wait
   * and does not care, because nothing the page sees depends on this.
   */
  offer(sessionId: string, url: string, tabId: string): void {
    if (!wanted(url)) return;
    const t = this.trackerFor(sessionId);
    if (t.seen.has(url)) return;
    // A run that loads code forever is a run whose URL list we stop keeping.
    // It costs the tail of a very long session, not correctness: those files
    // are still fetched the old way, when someone opens one.
    if (t.seen.size >= this.maxTracked) return;
    t.seen.add(url);
    t.queue.push(url);
    // Remember which window had it: that window has the route and the cookies
    // for it, and in a cross-origin chain no other one does.
    t.tabs.set(url, tabId);
    this.scheduleDrain(t);
  }

  /** A session ended or was deleted: drop everything still queued for it. */
  forget(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (t?.timer) clearTimeout(t.timer);
    this.tracked.delete(sessionId);
    this.settleIfIdle();
  }

  /** Resolves when nothing is queued or in flight. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** What is still outstanding, for the logs. */
  pending(): number {
    let n = this.inFlight;
    for (const t of this.tracked.values()) n += t.queue.length;
    return n;
  }

  // ------------------------------------------------------------------ internals

  private trackerFor(sessionId: string): Tracked {
    let t = this.tracked.get(sessionId);
    if (!t) {
      t = { seen: new Set(), queue: [], tabs: new Map(), timer: null };
      this.tracked.set(sessionId, t);
    }
    return t;
  }

  /** Restart the settle timer on every offer, so a burst is fetched as one. */
  private scheduleDrain(t: Tracked): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.drain();
    }, this.settleMs);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.inFlight < this.concurrency) {
        const next = this.takeNext();
        if (!next) break;
        this.inFlight++;
        void this.collect(next.sessionId, next.url, next.tabId).finally(() => {
          this.inFlight--;
          if (this.isIdle()) this.settleIfIdle();
          else void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  /** One url from each session in turn, so a busy run cannot starve a quiet one. */
  private takeNext(): { sessionId: string; url: string; tabId?: string } | null {
    for (const [sessionId, t] of this.tracked) {
      const url = t.queue.shift();
      if (url === undefined) continue;
      // Rotate this session to the back of the map for the next round.
      this.tracked.delete(sessionId);
      this.tracked.set(sessionId, t);
      return { sessionId, url, tabId: t.tabs.get(url) };
    }
    return null;
  }

  private async collect(sessionId: string, url: string, tabId?: string): Promise<void> {
    try {
      // Already held from an earlier run of this session, or from before a
      // relay restart, when `seen` was empty but the file was on disk.
      if (await this.blobs.lookup(sessionId, url)) return;
      const asset = await this.fetchAsset(sessionId, url, tabId);
      // No live window, an opaque cross-origin response, a 404: all the same
      // answer here. `seen` already holds the url, so it is not tried again.
      if (!asset?.body) return;
      const body = Buffer.from(asset.body, 'base64');
      const mime = asset.mimeType ?? '';
      const kept = await this.blobs.put(sessionId, url, body, mime);
      // The store refused something of a kind it keeps, so the refusal was
      // the session's budget. Nothing further will fit either, and every
      // fetch behind it is work in someone's page for bytes we would throw
      // away — so stop. Opening a file by hand still works, and still refuses.
      if (!kept && classify(mime, body.length) !== 'refuse') this.forget(sessionId);
    } catch {
      /* a background nicety: never worth taking a session down for */
    }
  }

  private isIdle(): boolean {
    if (this.inFlight > 0) return false;
    for (const t of this.tracked.values()) if (t.queue.length > 0 || t.timer) return false;
    return true;
  }

  private settleIfIdle(): void {
    if (!this.isIdle()) return;
    while (this.idleWaiters.length) this.idleWaiters.shift()!();
  }
}

/**
 * Whether a URL is the kind of thing worth pulling in on its own.
 *
 * Deliberately narrow. The cost of saying yes wrongly is work in someone's
 * page; the cost of saying no wrongly is that a file is fetched the old way,
 * when it is opened.
 */
export function wanted(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // Our own traffic: the agent, the asset proxy, the connectivity probes.
  if (u.pathname === '/agent.js' || u.pathname.startsWith('/asset/') || u.pathname.startsWith('/ping/')) return false;
  const last = u.pathname.split('/').pop() ?? '';
  const ext = last.includes('.') ? last.split('.').pop()!.toLowerCase() : '';
  // A path with no extension is usually a document or an API route, and from
  // here the two are indistinguishable. The document the run started on is
  // already covered: the Sources list names it, and `sources.get` stores it.
  return WANTED.has(ext);
}
