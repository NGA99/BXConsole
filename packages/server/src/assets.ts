/**
 * The asset cache behind `GET /asset/{sessionId}/{base64url(url)}`.
 *
 * Nothing here ever reaches out to the network. A miss is answered by asking
 * the debugged page to fetch the file with its own network and credentials
 * (see the agent's `asset.get`), and the bytes are then kept in the session
 * directory. Two consequences worth stating:
 *
 *   - an intranet page's images work in the console even though the console's
 *     own browser could never have loaded them;
 *   - once a file has been looked at, it is part of the recording, so a replay
 *     weeks later still draws the page instead of a grid of broken images.
 *
 * Keyed by URL, one copy per session. A URL whose content changes during the
 * run keeps whichever version was seen first — faithful enough for a mirror,
 * and the alternative (a copy per moment) would cost far more than it is
 * worth.
 */
import { ASSET_MAX_BYTES, type AssetData } from '@bxconsole/protocol';
import type { BlobStore } from './blobs';

export interface Asset {
  body: Buffer;
  mimeType: string;
}

/** How long a "the page cannot read this" verdict stands before we ask again. */
const UNREADABLE_TTL_MS = 5 * 60_000;

interface AssetMeta {
  url: string;
  mimeType: string;
  size: number;
  ts: number;
}

/** Asks a live window for a URL; null when none of the session is connected. */
export type AssetFetcher = (sessionId: string, url: string, tabId?: string) => Promise<AssetData | null>;

export class AssetCache {
  /**
   * (session, url) the page has told us it cannot read, and when to ask again.
   * Without this a mirror full of CDN icons asks the page for every one of
   * them on every re-render, and waits out a network error each time.
   */
  private readonly unreadable = new Map<string, number>();
  /** one in-flight fetch per (session, tab, url), so a page of 40 identical icons asks once */
  private readonly inFlight = new Map<string, Promise<Asset | null>>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly fetchFromPage: AssetFetcher,
    /** kept for the budget the README promises; the blob store holds the bytes */
    private readonly maxBytes: number = ASSET_MAX_BYTES,
  ) {}

  async get(sessionId: string, url: string, tabId?: string): Promise<Asset | null> {
    // The bytes at a url are the bytes at that url, whichever window fetched
    // them, so the stored copy is shared. Only the asking is per window,
    // because which windows *can* read a url differs.
    const held = await this.blobs.lookup(sessionId, url);
    if (held) {
      const body = await this.blobs.read(held.sha);
      if (body) return { body, mimeType: held.mime };
    }

    const key = `${sessionId}|${tabId ?? ''}|${url}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    const job = this.fetchAndStore(sessionId, url, tabId).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async fetchAndStore(sessionId: string, url: string, tabId?: string): Promise<Asset | null> {
    // Per window: one window being unable to read a cross-origin file says
    // nothing about another window, which may be on that very origin.
    const key = `${sessionId}|${tabId ?? ''}|${url}`;
    const until = this.unreadable.get(key);
    if (until !== undefined) {
      if (until > Date.now()) return null;
      this.unreadable.delete(key);
    }
    const data = await this.fetchFromPage(sessionId, url, tabId);
    if (!data?.body) {
      // Remember only a real answer. "No window connected" is not the page
      // telling us anything, and it stops being true the moment one reloads.
      if (data) {
        // A relay runs for weeks; a page with a wall of broken images must not
        // grow this map without end. Starting over costs one retry each.
        if (this.unreadable.size > 5000) this.unreadable.clear();
        this.unreadable.set(key, Date.now() + UNREADABLE_TTL_MS);
      }
      return null;
    }
    const body = Buffer.from(data.body, 'base64');
    const mimeType = data.mimeType || guessType(url);
    // Serve it either way; only the keeping is the store's business.
    void this.blobs.put(sessionId, url, body, mimeType).catch(() => undefined);
    return { body, mimeType };
  }

  /** Resolves once every store queued for this session has landed. */
  async whenStored(sessionId: string): Promise<void> {
    await this.blobs.whenQuiet(sessionId);
  }

  /** The budget the relay was started with, for whoever reports it. */
  get budget(): number {
    return this.maxBytes;
  }
}

/** Last resort when the page's response carried no content-type. */
function guessType(url: string): string {
  const ext = (url.split('?')[0]!.split('#')[0]!.split('.').pop() ?? '').toLowerCase();
  return (
    {
      css: 'text/css',
      js: 'text/javascript',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
      mp4: 'video/mp4',
      webm: 'video/webm',
    }[ext] ?? 'application/octet-stream'
  );
}
