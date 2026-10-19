/**
 * A password on the operator's half of the relay.
 *
 * The relay has two kinds of caller and only one of them can be asked for
 * anything. A victim's browser fetches `/agent.js`, opens `/ws/agent` and
 * fires the `/ping` probes with nobody at the keyboard — those have to stay
 * open or the tool does not work. Everything else is the operator's: the
 * console, its socket, the recordings, the asset and body proxies, and the
 * pre-payload, which is arbitrary JS that every agent asking for it will run.
 *
 * So the guard is a list of what is open and a refusal for the rest. It lives
 * here rather than in a reverse proxy's config because the split is a fact
 * about the routes, and the routes are in this package: when `/pre-payload`
 * was added, no proxy config anywhere would have known to protect it. New
 * endpoints are closed by default, which is the point.
 *
 * Accounts come from `.passwd` (see ./passwd), or from CONSOLE_PASSWORD when
 * there is no file. One account either way, for now.
 *
 * Two things about the cookie are worth stating, because they are what makes
 * this cheap and what makes it revocable:
 *
 *   - scrypt runs once, at sign-in. The cookie is an HMAC, so `allows` is a
 *     hash and a compare — which matters, because it runs on every request
 *     and on every WebSocket handshake.
 *   - the HMAC's key is the stored credential line itself. Change a password
 *     and the line changes, so every cookie issued against the old one stops
 *     verifying. Revocation without the relay keeping any session state.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Account, PasswordFile, accountFromEnv, verifyPassword } from './passwd';

/**
 * The default is in the source of a public repository, so it is a lock on the
 * door rather than a secret. Set CONSOLE_PASSWORD, or better, make a .passwd.
 */
const DEFAULT_PASSWORD = 'asdf1234!@#';

/** The account name used when there is no file to name one. */
export const DEFAULT_USER = 'admin';

export const COOKIE_NAME = '__wvs';

/** Paths a browser nobody is sitting at has to reach. Everything else is closed. */
export function isVictimPath(pathname: string): boolean {
  return pathname === '/agent.js' || pathname === '/ping' || pathname.startsWith('/ping/');
}

export interface AuthOptions {
  /** Path to `.passwd`. Absent means env-only, which is what tests want. */
  file?: string;
  /** Overrides CONSOLE_PASSWORD for the no-file fallback. */
  password?: string;
  warn?: (message: string) => void;
}

export class ConsoleAuth {
  private readonly file: PasswordFile | null;
  private readonly fallback: Account;
  private readonly fallbackIsDefault: boolean;

  constructor(opts: AuthOptions = {}) {
    const warn = opts.warn ?? (() => undefined);
    this.file = opts.file ? new PasswordFile(opts.file, warn) : null;
    const password = opts.password ?? process.env.CONSOLE_PASSWORD ?? DEFAULT_PASSWORD;
    this.fallbackIsDefault = password === DEFAULT_PASSWORD;
    this.fallback = accountFromEnv(DEFAULT_USER, password);
  }

  /** Read `.passwd` now, so a file the operator must fix is loud at startup. */
  load(): void {
    this.file?.loadOrThrow();
  }

  /** Whether this request carries a cookie we issued. */
  allows(req: IncomingMessage): boolean {
    const given = cookie(req.headers.cookie, COOKIE_NAME);
    if (!given) return false;
    const dot = given.lastIndexOf('.');
    if (dot <= 0) return false;
    const account = this.accountFor(given.slice(0, dot));
    if (!account) return false;
    let got: Buffer;
    try {
      got = Buffer.from(given.slice(dot + 1), 'hex');
    } catch {
      return false;
    }
    const want = tokenFor(account);
    // Lengths differ on a malformed cookie, and timingSafeEqual throws on that.
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** The Set-Cookie value for a correct password, or null for a wrong one. */
  async cookieFor(password: string, user: string = this.userName()): Promise<string | null> {
    const account = this.accountFor(user);
    if (!account) return null;
    const ok = account.record.startsWith('env$')
      ? constantEquals(accountFromEnv(account.user, password).record, account.record)
      : await verifyPassword(password, account.record);
    if (!ok) return null;
    // HttpOnly so a cross-site script cannot read it; SameSite=Strict so it is
    // not sent from anywhere else. Not Secure, because a relay on a plain
    // http:// address would then never receive it back.
    const value = `${account.user}.${tokenFor(account).toString('hex')}`;
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
  }

  /** Where accounts are coming from, for the startup banner. */
  get source(): 'file' | 'env' {
    return this.file && !this.file.isMissing ? 'file' : 'env';
  }

  /** True when the password is still the one printed in the repository. */
  get isDefault(): boolean {
    return this.source === 'env' && this.fallbackIsDefault;
  }

  /** The account name to sign in as, while one account is the limit. */
  userName(): string {
    return (this.file?.only() ?? this.fallback).user;
  }

  private accountFor(user: string): Account | null {
    if (this.file && !this.file.isMissing) return this.file.find(user);
    return user === this.fallback.user ? this.fallback : null;
  }
}

/**
 * The cookie's value: HMAC of the account name under the stored line.
 *
 * Keyed on the line rather than a server secret so that changing a password
 * invalidates the cookies issued under it, and so that nothing has to be
 * persisted for a cookie to survive a restart.
 */
function tokenFor(account: Account): Buffer {
  return createHmac('sha256', account.record).update(account.user).digest();
}

/** Comparing two records without leaking where they first differ. */
function constantEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** The sign-in page, served in place of the console to anyone without the cookie. */
export function loginPage(wrong: boolean, tooMany = false): string {
  const message = tooMany
    ? '<p class="bad">Too many attempts. Wait a minute.</p>'
    : wrong
      ? '<p class="bad">Wrong password.</p>'
      : '<p>This relay is password-protected.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BXConsole</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:light dark}
 body{font:14px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
 form{display:grid;gap:10px;width:min(300px,86vw)}
 h1{font-size:15px;margin:0 0 4px}
 input{font:inherit;padding:8px;border:1px solid #8884;border-radius:5px;background:canvas;color:canvastext}
 button{font:inherit;padding:8px;border:0;border-radius:5px;background:#1a73e8;color:#fff;cursor:pointer}
 p{margin:0;color:#8a8a8a}
 .bad{color:#c5221f}
</style></head><body>
<form method="POST" action="/login">
 <h1>BXConsole</h1>
 ${message}
 <input type="password" name="password" autofocus autocomplete="current-password" placeholder="Password">
 <button type="submit">Sign in</button>
</form>
</body></html>`;
}

/** Refuse a request that is not signed in, in whatever way suits the caller. */
export function refuse(req: IncomingMessage, res: ServerResponse): void {
  // A browser navigation gets a page it can act on; anything else gets a status
  // it can handle, so a fetch does not silently parse HTML as its answer.
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  if (wantsHtml && req.method === 'GET') {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginPage(false));
    return;
  }
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('sign in at / first');
}
