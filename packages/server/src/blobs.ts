/**
 * One copy of every file the debugged pages handed over.
 *
 * The same bundle is fetched more than once today — by the page itself, by
 * the Sources tab, by the Network body view, by the Screen mirror — and once
 * per session on top of that. Stored by content hash and shared across
 * sessions, it is fetched once and read many times, which is politer to an
 * intranet server and makes a recording still readable after the next deploy
 * has replaced the original.
 *
 * Content hash for the bytes, per-session mapping for the meaning: a url's
 * contents change between runs, so "what session X saw at url U" is the
 * question, and only the session can answer it. Keying the cache on the url
 * alone would quietly serve last week's run this week's code.
 *
 * Deletion is mark-and-sweep. Reference counts are exact until the process
 * dies mid-write and then they are silently wrong; a sweep re-derives the
 * truth from the sessions that exist, so it heals itself. The cost is that
 * deleting a session does not free its bytes until the sweep has run.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BLOB_DIR, BLOB_MAX_BYTES, SESSION_BODIES_INDEX, SESSION_FILES_INDEX, sessionDirName } from '@bxconsole/protocol';

/**
 * How recently a blob may have been written and still be swept.
 *
 * Long enough to cover the gap between writing a blob and appending the line
 * that references it, which is one `appendFile` apart; short enough that a
 * genuine orphan is not kept around for any length of time. A test that is
 * about what gets collected, rather than about when, passes its own.
 */
const SWEEP_GRACE_MS = 60_000;

/** What a session saw at one url. */
export interface FileRecord {
  ts: number;
  url: string;
  sha: string;
  bytes: number;
  mime: string;
  /** `keep` is read later (code, markup); `cache` only has to outlive the mirror */
  kind: 'keep' | 'cache';
}

/**
 * Whether a response is worth storing at all.
 *
 * Code and markup are what someone reads, and they deduplicate well. Pictures
 * and fonts are needed to draw a past frame but never read. Media is neither:
 * it is large, it arrives in ranges, and nobody has ever debugged a bug by
 * reading an mp4.
 */
export function classify(mime: string, bytes: number): FileRecord['kind'] | 'refuse' {
  if (bytes > BLOB_MAX_BYTES) return 'refuse';
  const type = mime.split(';')[0]!.trim().toLowerCase();
  if (/^(video|audio)\//.test(type)) return 'refuse';
  if (/^image\/svg\+xml$/.test(type)) return 'keep'; // markup, not a picture
  if (/^text\//.test(type)) return 'keep';
  if (/^application\/(javascript|ecmascript|x-javascript|json|xml|wasm)$/.test(type)) return 'keep';
  if (/\+(json|xml)$/.test(type)) return 'keep';
  if (/^(image|font)\//.test(type)) return 'cache';
  if (/^application\/font/.test(type)) return 'cache';
  // An unlabelled response is usually a script or a document; treat it as
  // readable rather than throwing it away.
  return type ? 'refuse' : 'keep';
}

/** One request or response body a session put in the store. */
export interface BodyRecord {
  ts: number;
  sha: string;
  bytes: number;
  mime: string;
}

export class BlobStore {
  /** url -> record, per session, read from disk the first time it is asked for */
  private readonly index = new Map<string, Map<string, FileRecord>>();
  /** sha -> record, per session: which bodies this run is allowed to read back */
  private readonly bodies = new Map<string, Map<string, BodyRecord>>();
  /** one append chain per session, so two writers cannot interleave a line */
  private readonly chains = new Map<string, Promise<void>>();

  /** bytes a session's own index accounts for, counted once and kept current */
  private readonly used = new Map<string, number>();

  constructor(
    private readonly rootDir: string,
    /**
     * What one session may cause to be stored. Shared bytes are counted
     * against every session that saw them, which overstates the disk — on
     * purpose: the budget is there to stop one runaway run, not to measure
     * the directory.
     */
    private readonly maxPerSession = Number.POSITIVE_INFINITY,
  ) {}

  /** What this session saw at this url, if it saw anything. */
  async lookup(sessionId: string, url: string): Promise<FileRecord | null> {
    const seen = await this.indexFor(sessionId);
    return seen.get(url) ?? null;
  }

  /** Everything this session is known to have fetched, oldest first. */
  async list(sessionId: string): Promise<FileRecord[]> {
    return [...(await this.indexFor(sessionId)).values()].sort((a, b) => a.ts - b.ts);
  }

  /** The bytes behind a record, or null if the sweep took them. */
  async read(sha: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(sha));
    } catch {
      return null;
    }
  }

  /**
   * Store what a session saw at a url. Returns the record, or null when the
   * response is not the kind worth keeping, or the session is over budget.
   *
   * One at a time per session: the budget is a read followed by a write, and
   * a mirror asks for forty files at once. Left to race, each would read the
   * same figure, each would decide it fits, and the budget would mean
   * nothing. Serialising also gives `whenQuiet` something to wait on.
   */
  put(sessionId: string, url: string, body: Buffer, mime: string): Promise<FileRecord | null> {
    const job = (this.chains.get(sessionId) ?? Promise.resolve()).then(() => this.putNow(sessionId, url, body, mime));
    this.chains.set(
      sessionId,
      job.then(
        () => undefined,
        () => undefined,
      ),
    );
    return job;
  }

  /**
   * Store a request or response body and answer with its hash.
   *
   * Unlike a file this is not keyed by url: one endpoint polled every second
   * is one url and a hundred bodies. Content addressing earns its keep here —
   * those hundred polls are usually one copy on disk.
   *
   * Null means the caller should keep the body where it was. A refusal here
   * must never lose a body that used to be recorded, so every caller has
   * somewhere to fall back to.
   */
  putBody(sessionId: string, body: Buffer, mime: string): Promise<string | null> {
    const job = (this.chains.get(sessionId) ?? Promise.resolve()).then(() => this.putBodyNow(sessionId, body, mime));
    this.chains.set(
      sessionId,
      job.then(
        () => undefined,
        () => undefined,
      ),
    );
    return job;
  }

  private async putBodyNow(sessionId: string, body: Buffer, mime: string): Promise<string | null> {
    // Size is the only question for a body. `classify` is about whether a file
    // is worth reading later, which a body already is by virtue of being one.
    if (body.length > BLOB_MAX_BYTES) return null;
    const sha = createHash('sha256').update(body).digest('hex');
    const held = await this.bodiesFor(sessionId);
    if (!held.has(sha)) {
      const used = await this.usedBy(sessionId);
      if (used + body.length > this.maxPerSession) return null;
      this.used.set(sessionId, used + body.length);
    } else {
      // The same bytes again — a poll returning what it returned last time.
      // Already paid for, already on disk, already listed.
      return sha;
    }

    const record: BodyRecord = { ts: Date.now(), sha, bytes: body.length, mime };
    await this.writeBlob(sha, body);
    held.set(sha, record);
    const dir = path.join(this.rootDir, sessionDirName(sessionId));
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, SESSION_BODIES_INDEX), `${JSON.stringify(record)}\n`);
    return sha;
  }

  /**
   * Whether this session is allowed to read this body.
   *
   * The hash alone would otherwise be a key to any body any run ever stored,
   * which is the sort of thing an intranet tool should not hand out.
   */
  async hasBody(sessionId: string, sha: string): Promise<BodyRecord | null> {
    return (await this.bodiesFor(sessionId)).get(sha) ?? null;
  }

  private async putNow(sessionId: string, url: string, body: Buffer, mime: string): Promise<FileRecord | null> {
    const kind = classify(mime, body.length);
    if (kind === 'refuse') return null;
    const sha = createHash('sha256').update(body).digest('hex');
    const seen = await this.indexFor(sessionId);
    // Already held by this session at this url: no new bytes, nothing to check.
    if (seen.get(url)?.sha !== sha) {
      const used = await this.usedBy(sessionId);
      if (used + body.length > this.maxPerSession) return null;
      this.used.set(sessionId, used + body.length);
    }
    const record: FileRecord = { ts: Date.now(), url, sha, bytes: body.length, mime, kind };

    await this.writeBlob(sha, body);

    seen.set(url, record);
    const dir = path.join(this.rootDir, sessionDirName(sessionId));
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, SESSION_FILES_INDEX), `${JSON.stringify(record)}\n`);
    return record;
  }

  /**
   * Delete every blob no session refers to any more.
   *
   * Derived from what is on disk rather than from a count kept in memory, so
   * a crash in the middle of anything leaves nothing permanently leaked.
   * Returns what it freed, which is what the caller logs.
   *
   * A blob is written before the index line that claims it, so between those
   * two moments it looks exactly like an orphan. A sweep that happened to run
   * in that window — deleting one recording while another is still collecting
   * — would take a file that a line was about to point at, and the loss would
   * only surface when someone opened that file weeks later. Hence the grace
   * period: anything written recently is left for the next sweep, by which
   * time its line has landed and it is either referenced or genuinely stale.
   */
  async sweep(graceMs = SWEEP_GRACE_MS): Promise<{ removed: number; bytes: number }> {
    const live = new Set<string>();
    let names: string[] = [];
    try {
      names = await fs.readdir(this.rootDir);
    } catch {
      return { removed: 0, bytes: 0 };
    }
    for (const name of names) {
      if (!name.startsWith('session-')) continue;
      const dir = path.join(this.rootDir, name);
      for (const record of (await this.readIndexFile(dir)).values()) live.add(record.sha);
      // Bodies are references too. Missing them here would have the sweep
      // delete the bytes behind every recorded response.
      for (const sha of (await this.readBodiesFile(dir)).keys()) live.add(sha);
    }

    let removed = 0;
    let bytes = 0;
    const root = path.join(this.rootDir, BLOB_DIR);
    for (const a of await safeReaddir(root)) {
      for (const b of await safeReaddir(path.join(root, a))) {
        const dir = path.join(root, a, b);
        for (const sha of await safeReaddir(dir)) {
          if (live.has(sha)) continue;
          const file = path.join(dir, sha);
          try {
            // A part-file from a write in flight is not an orphan yet.
            if (sha.endsWith('.part')) continue;
            const { size, mtimeMs } = await fs.stat(file);
            // Too young to judge: its index line may still be on its way.
            if (Date.now() - mtimeMs < graceMs) continue;
            await fs.rm(file);
            removed++;
            bytes += size;
          } catch {
            /* gone already, or being written */
          }
        }
      }
    }
    return { removed, bytes };
  }

  /** What this session's index accounts for, summed once. */
  private async usedBy(sessionId: string): Promise<number> {
    const known = this.used.get(sessionId);
    if (known !== undefined) return known;
    let total = 0;
    for (const record of (await this.indexFor(sessionId)).values()) total += record.bytes;
    for (const record of (await this.bodiesFor(sessionId)).values()) total += record.bytes;
    this.used.set(sessionId, total);
    return total;
  }

  /** Resolves once every append queued for this session has landed. */
  async whenQuiet(sessionId: string): Promise<void> {
    await this.chains.get(sessionId);
  }

  /** Forget a session's index; its file goes with the directory. */
  forget(sessionId: string): void {
    this.index.delete(sessionId);
    this.bodies.delete(sessionId);
    this.chains.delete(sessionId);
    this.used.delete(sessionId);
  }

  // ------------------------------------------------------------------ internals

  /** Put the bytes under their hash, once, whoever asked for it. */
  private async writeBlob(sha: string, body: Buffer): Promise<void> {
    const file = this.pathFor(sha);
    try {
      await fs.access(file); // already held: every session that saw it shares this copy
      return;
    } catch {
      /* not here yet */
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write beside it and rename, so a reader never sees half a file under a
    // name that promises its hash.
    const tmp = `${file}.${process.pid}.part`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
  }

  private pathFor(sha: string): string {
    return path.join(this.rootDir, BLOB_DIR, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  private async indexFor(sessionId: string): Promise<Map<string, FileRecord>> {
    const held = this.index.get(sessionId);
    if (held) return held;
    const loaded = await this.readIndexFile(path.join(this.rootDir, sessionDirName(sessionId)));
    this.index.set(sessionId, loaded);
    return loaded;
  }

  private async bodiesFor(sessionId: string): Promise<Map<string, BodyRecord>> {
    const held = this.bodies.get(sessionId);
    if (held) return held;
    const loaded = await this.readBodiesFile(path.join(this.rootDir, sessionDirName(sessionId)));
    this.bodies.set(sessionId, loaded);
    return loaded;
  }

  /** Newest line per url wins, so a url refetched after a deploy reads as what it is now. */
  private async readIndexFile(dir: string): Promise<Map<string, FileRecord>> {
    const out = new Map<string, FileRecord>();
    for (const record of await readRecords<FileRecord>(path.join(dir, SESSION_FILES_INDEX))) {
      if (record.url && record.sha) out.set(record.url, record);
    }
    return out;
  }

  /** Keyed by hash: the same bytes recorded twice are one entry and one file. */
  private async readBodiesFile(dir: string): Promise<Map<string, BodyRecord>> {
    const out = new Map<string, BodyRecord>();
    for (const record of await readRecords<BodyRecord>(path.join(dir, SESSION_BODIES_INDEX))) {
      if (record.sha) out.set(record.sha, record);
    }
    return out;
  }

}

/** Every intact line of an ndjson index; a half-written one from a crash is skipped. */
async function readRecords<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a half-written line from a crash: skip it */
    }
  }
  return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
