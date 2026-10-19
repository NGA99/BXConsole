/**
 * The password file: who may use the operator's half of the relay.
 *
 * One line per account, `#` for comments:
 *
 *   admin:scrypt$16384$8$1$<salt-hex>$<hash-hex>
 *
 * A file rather than an environment variable because of what changing the
 * password costs. `CONSOLE_PASSWORD` is read once at startup, so rotating it
 * means restarting the relay, and restarting the relay drops every agent
 * socket — ending runs that cannot be started again, because the admin who
 * opened that ticket will not open it twice. This is re-read when its mtime
 * moves, so a password changes without a live session noticing.
 *
 * scrypt and not SHA-256 because this file is a credential at rest. The
 * cookie token elsewhere is derived from a password already known to the
 * process; this is the thing an attacker takes away and grinds offline, where
 * a bare SHA-256 falls at billions of guesses a second.
 *
 * The parameters are written into each line, so they can be raised later
 * without invalidating hashes already in the file.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promises as fs, readFileSync, statSync } from 'node:fs';

/**
 * Promisified by hand: `promisify` picks the three-argument overload and
 * drops the options, which is where the cost parameters live.
 */
function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Cost of a new hash. Node's own defaults, which need 16 MB to verify. */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const;

/** How long a loaded file is trusted before its mtime is checked again. */
const RECHECK_MS = 1000;

export interface Account {
  readonly user: string;
  /** The stored line's credential half, verbatim. Also the cookie's HMAC key:
   *  change the password and every cookie issued against the old one dies. */
  readonly record: string;
}

/** Build a `scrypt$...` record for a password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Whether `password` is the one `record` was made from. */
export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const parts = record.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts as [string, string, string, string, string, string];
  const N = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  // A line claiming a cost we will not pay is a refusal, not a slow verify.
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || !Number.isInteger(rr) || !Number.isInteger(pp)) return false;
  let salt: Buffer;
  let want: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    want = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || want.length === 0) return false;
  let got: Buffer;
  try {
    // maxmem must cover 128 * N * r, which the defaults do not above N=16384.
    got = await scrypt(password, salt, want.length, { N, r: rr, p: pp, maxmem: 256 * N * rr + 1024 * 1024 });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Why a file was rejected, in the words the operator needs to fix it. */
export class PasswdError extends Error {}

/**
 * The accounts on disk, re-read when the file changes.
 *
 * Only one account is honoured for now. Extra lines are ignored rather than
 * silently granted: an entry nobody meant to add should not be a way in, and
 * the warning says the limit out loud so the second person is not left
 * guessing why their password stopped working.
 */
export class PasswordFile {
  private accounts: Account[] = [];
  private loadedMtime = -1;
  private checkedAt = 0;
  /** Set when the file is absent, so a caller can fall back and say so. */
  private missing = true;

  constructor(
    private readonly path: string,
    private readonly warn: (msg: string) => void = () => undefined,
  ) {}

  get isMissing(): boolean {
    this.refreshIfStale();
    return this.missing;
  }

  /** The account for a user, or null. Cheap: no hashing, no read when fresh. */
  find(user: string): Account | null {
    this.refreshIfStale();
    return this.accounts.find((a) => a.user === user) ?? null;
  }

  /** The single account, while one account is the limit. */
  only(): Account | null {
    this.refreshIfStale();
    return this.accounts[0] ?? null;
  }

  /**
   * Read the file now, throwing PasswdError on anything the operator must fix.
   * Called once at startup so a broken file is loud; after that the reloads
   * below are quiet, because a half-saved file should not take the relay down
   * in the middle of a run.
   */
  loadOrThrow(): void {
    const parsed = read(this.path);
    if (parsed === null) {
      this.missing = true;
      this.accounts = [];
      this.loadedMtime = -1;
      return;
    }
    this.apply(parsed);
  }

  private refreshIfStale(): void {
    const now = Date.now();
    if (now - this.checkedAt < RECHECK_MS) return;
    this.checkedAt = now;
    let parsed: Parsed | null;
    try {
      parsed = read(this.path, this.loadedMtime);
    } catch (err) {
      // An editor mid-save, a chmod that has not finished, a truncated write.
      // Keep serving what we had and say so; the next check will pick it up.
      this.warn(`.passwd not reloaded: ${(err as Error).message}`);
      return;
    }
    if (parsed === null) {
      if (!this.missing) this.warn('.passwd has gone; falling back to CONSOLE_PASSWORD');
      this.missing = true;
      this.accounts = [];
      this.loadedMtime = -1;
      return;
    }
    if (parsed === UNCHANGED) return;
    this.apply(parsed);
    this.warn('.passwd reloaded');
  }

  private apply(parsed: Parsed): void {
    if (parsed.accounts.length > 1) {
      this.warn(
        `.passwd holds ${parsed.accounts.length} accounts and only one is supported yet; ` +
          `using "${parsed.accounts[0]!.user}" and ignoring the rest`,
      );
    }
    this.accounts = parsed.accounts.slice(0, 1);
    this.loadedMtime = parsed.mtime;
    this.missing = false;
  }
}

interface Parsed {
  accounts: Account[];
  mtime: number;
}
const UNCHANGED = { accounts: [], mtime: -1 } as Parsed;

/** Read and parse, or null when absent, or UNCHANGED when the mtime matches. */
function read(path: string, knownMtime = -2): Parsed | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  /*
   * Refuse a file anyone else on the machine can read. This is the one place
   * the tool holds a credential at rest, and a 0644 .passwd on a shared box
   * is the whole point of hashing it undone. Fail loudly rather than carry
   * on: `chmod 600` is a one-line fix and the message says so.
   */
  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    throw new PasswdError(
      `${path} is mode ${mode.toString(8)} and readable by others — run: chmod 600 ${path}`,
    );
  }
  const mtime = stat.mtimeMs;
  if (mtime === knownMtime) return UNCHANGED;

  const text = readFileSync(path, 'utf8');
  const accounts: Account[] = [];
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at <= 0) throw new PasswdError(`${path}:${lineNo}: expected "user:hash"`);
    const user = line.slice(0, at).trim();
    const record = line.slice(at + 1).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
      throw new PasswdError(`${path}:${lineNo}: "${user}" is not a usable account name`);
    }
    if (!record.startsWith('scrypt$')) {
      throw new PasswdError(`${path}:${lineNo}: "${user}" has no scrypt hash — run: npm run passwd -- ${user}`);
    }
    if (accounts.some((a) => a.user === user)) {
      throw new PasswdError(`${path}:${lineNo}: "${user}" appears twice`);
    }
    accounts.push({ user, record });
  }
  if (accounts.length === 0) throw new PasswdError(`${path} holds no accounts`);
  return { accounts, mtime };
}

/** An account synthesised from CONSOLE_PASSWORD, for a relay with no file. */
export function accountFromEnv(user: string, password: string): Account {
  // The record is the cookie's HMAC key, so it has to change with the
  // password and must not be the password itself.
  return { user, record: `env$${createHash('sha256').update(`bxconsole:${password}`).digest('hex')}` };
}

/** Writing the file, used by the CLI. 0600 from the moment it exists. */
export async function writeAccounts(path: string, accounts: Account[]): Promise<void> {
  const body = [
    '# BXConsole operator accounts. One per line: user:scrypt$N$r$p$salt$hash',
    '# Add or change one with: npm run passwd -- <user>',
    '# The relay re-reads this when it changes; no restart, no dropped sessions.',
    ...accounts.map((a) => `${a.user}:${a.record}`),
    '',
  ].join('\n');
  await fs.writeFile(path, body, { mode: 0o600 });
  // writeFile's mode only applies on create, so an existing file keeps its own.
  await fs.chmod(path, 0o600);
}
