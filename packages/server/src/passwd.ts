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
import type { AccountRole } from '@bxconsole/protocol';
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

/**
 * What an account may do. Two, because a third has never been needed.
 *
 * Defined in the protocol package, because the console decides what to show
 * from it — an admin screen only an administrator sees — and two copies of a
 * two-value union is exactly the pair that drifts.
 */
export type { AccountRole as Role };

export interface Account {
  readonly user: string;
  /** The stored line's credential half, verbatim. Also the cookie's HMAC key:
   *  change the password and every cookie issued against the old one dies. */
  readonly record: string;
  /**
   * The name this account is known by everywhere except this file.
   *
   * Projects record who owns them, and they have to go on meaning the same
   * person when the account is renamed or its password changes — so what they
   * record is this, not the user name and not the credential.
   *
   * Assigned once, when the account is created, and never derived from the
   * name. Deriving it would be less to store and would quietly hand a new
   * person the projects of a deleted one who happened to be called the same
   * thing, which in a tool holding engagement data is not a trade worth
   * making. A file written before ids existed gets one derived on the way in
   * and a line in the log saying how to pin it.
   */
  readonly id: string;
  readonly role: AccountRole;
}

/** An id for a line that predates them. Stable, so a restart agrees with itself. */
export function derivedId(user: string): string {
  return createHash('sha256').update(`bxconsole:account:${user}`).digest('hex').slice(0, 12);
}

/**
 * The id the first account on a relay gets, whether it came from the
 * environment or from the file.
 *
 * A relay with no `.passwd` runs on CONSOLE_PASSWORD as one synthetic
 * account, and anything made under it — the home project, and so every
 * recording — is owned by that account's id. The startup banner then tells
 * the operator to run `npm run passwd`, and the account that writes is the
 * same person on the same relay. Drawing it a fresh id there would hand them
 * a working sign-in and an empty console: their own projects owned by an id
 * no account has any more, readable by nobody, with nothing anywhere saying
 * why.
 *
 * So the two agree by construction. Only the first account of a file that
 * did not exist gets this; everybody added afterwards is drawn one of their
 * own.
 */
export const FIRST_ACCOUNT_ID = derivedId('admin');

export function newAccountId(): string {
  return randomBytes(6).toString('hex');
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
  /** It loaded once and the file has since gone: see the warning in refreshIfStale. */
  private vanished = false;

  constructor(
    /** Readable because the admin screen writes this file back through it. */
    readonly path: string,
    private readonly warn: (msg: string) => void = () => undefined,
  ) {}

  /**
   * Whether this file was read and has since disappeared, as opposed to
   * never having been there. The relay with no file at all is a supported
   * way to run; a file that goes missing under a running relay is not.
   */
  get hasVanished(): boolean {
    this.refreshIfStale();
    return this.vanished;
  }

  get isMissing(): boolean {
    this.refreshIfStale();
    return this.missing;
  }

  /** The account for a user, or null. Cheap: no hashing, no read when fresh. */
  find(user: string): Account | null {
    this.refreshIfStale();
    return this.accounts.find((a) => a.user === user) ?? null;
  }

  /** Every account, for the CLI and the admin screen. */
  all(): readonly Account[] {
    this.refreshIfStale();
    return this.accounts;
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

  /**
   * Re-read now, past the once-a-second throttle.
   *
   * For the one caller that knows the file changed because it wrote it: the
   * admin screen. Without this the throttle made the screen lie — the account
   * was added, the file was correct, and the list sent straight back was the
   * one from before the write, so adding somebody looked like it had failed.
   */
  reloadNow(): void {
    this.checkedAt = 0;
    this.refreshIfStale();
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
      /*
       * The file was there and is not any more.
       *
       * This used to fall back to CONSOLE_PASSWORD, which was reasonable
       * when the fallback meant "one operator, one password" and is not now.
       * The fallback account is named `admin` with an id derived from that
       * name — the id that owns the home project on most relays — and when
       * CONSOLE_PASSWORD is unset its password is the one printed in the
       * repository. So a `.passwd` lost to a bad deploy or a stray cleanup
       * handed every recording on the relay to anyone who had read the
       * README.
       *
       * It fails closed instead: nobody signs in until the file is back,
       * and every cookie stops working at once, which is loud in the one way
       * that gets noticed. The agents are untouched and keep recording —
       * that is the part that cannot be restarted. An operator who really
       * does mean to go back to the environment password restarts the relay,
       * which is the deliberate act that says so.
       */
      if (!this.missing) {
        this.vanished = true;
        this.warn('.passwd has gone. Nobody can sign in until it is back; restart to use CONSOLE_PASSWORD instead.');
      }
      this.missing = true;
      this.accounts = [];
      this.loadedMtime = -1;
      return;
    }
    if (parsed === UNCHANGED) return;
    const wasGone = this.vanished;
    this.vanished = false;
    this.apply(parsed);
    this.warn(wasGone ? '.passwd is back; signing in works again' : '.passwd reloaded');
  }

  private apply(parsed: Parsed): void {
    if (parsed.legacy.length) {
      this.warn(
        `.passwd: ${parsed.legacy.join(', ')} ${parsed.legacy.length === 1 ? 'has' : 'have'} no account id, ` +
          'so one is derived from the name — run: npm run passwd -- --pin-ids',
      );
    }
    this.accounts = parsed.accounts;
    this.loadedMtime = parsed.mtime;
    this.missing = false;
  }
}

interface Parsed {
  accounts: Account[];
  mtime: number;
  /** Account names whose id was derived rather than read. */
  legacy: string[];
}
const UNCHANGED = { accounts: [], mtime: -1, legacy: [] } as Parsed;

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
  /** Lines with no id of their own, reported once so they can be pinned. */
  const legacy: string[] = [];
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    /*
     * `user:record[:id[:role]]`. The record holds its own fields on `$`, so
     * the colons after it are free; a file written before ids and roles
     * existed is three fields short and still reads.
     */
    const at = line.indexOf(':');
    if (at <= 0) throw new PasswdError(`${path}:${lineNo}: expected "user:hash"`);
    const user = line.slice(0, at).trim();
    const [record = '', id, role] = line
      .slice(at + 1)
      .split(':')
      .map((s) => s.trim());
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
      throw new PasswdError(`${path}:${lineNo}: "${user}" is not a usable account name`);
    }
    if (!record.startsWith('scrypt$')) {
      throw new PasswdError(`${path}:${lineNo}: "${user}" has no scrypt hash — run: npm run passwd -- ${user}`);
    }
    if (id !== undefined && !/^[a-f0-9]{6,32}$/.test(id)) {
      throw new PasswdError(`${path}:${lineNo}: "${id}" is not a usable account id`);
    }
    if (role !== undefined && role !== 'admin' && role !== 'member') {
      throw new PasswdError(`${path}:${lineNo}: "${role}" is not a role — expected admin or member`);
    }
    if (accounts.some((a) => a.user === user)) {
      throw new PasswdError(`${path}:${lineNo}: "${user}" appears twice`);
    }
    if (id === undefined) legacy.push(user);
    accounts.push({
      user,
      record,
      id: id ?? derivedId(user),
      // A file with no roles in it at all is the one written before they
      // existed, which holds one account and that account is the operator.
      // Anyone added after the first starts out as a member.
      role: role ?? (accounts.length === 0 ? 'admin' : 'member'),
    });
  }
  if (accounts.length === 0) throw new PasswdError(`${path} holds no accounts`);
  /*
   * All of them or none. A file half in each scheme is being hand-edited, and
   * deriving the ids that are missing would hand ownership out by coincidence
   * — so it is a thing to fix rather than to guess at.
   */
  if (legacy.length && legacy.length !== accounts.length) {
    throw new PasswdError(`${path}: some accounts have an id and some do not — run: npm run passwd -- --pin-ids`);
  }
  return { accounts, mtime, legacy };
}

/** An account synthesised from CONSOLE_PASSWORD, for a relay with no file. */
export function accountFromEnv(user: string, password: string): Account {
  // The record is the cookie's HMAC key, so it has to change with the
  // password and must not be the password itself. An id derived from the
  // name rather than drawn at random, so a relay running on the environment
  // variable owns the same projects after a restart.
  return {
    user,
    record: `env$${createHash('sha256').update(`bxconsole:${password}`).digest('hex')}`,
    id: derivedId(user),
    role: 'admin',
  };
}

/** Writing the file, used by the CLI. 0600 from the moment it exists. */
export async function writeAccounts(path: string, accounts: Account[]): Promise<void> {
  const body = [
    '# BXConsole operator accounts. One per line:',
    '#   user:scrypt$N$r$p$salt$hash:id:role      role is admin or member',
    '# Add or change one with: npm run passwd -- <user> [--role admin|member]',
    '# List them: --list   Remove one: --remove <user>   Give them ids: --pin-ids',
    '# The relay re-reads this when it changes; no restart, no dropped sessions.',
    ...accounts.map((a) => `${a.user}:${a.record}:${a.id}:${a.role}`),
    '',
  ].join('\n');
  await fs.writeFile(path, body, { mode: 0o600 });
  // writeFile's mode only applies on create, so an existing file keeps its own.
  await fs.chmod(path, 0o600);
}
