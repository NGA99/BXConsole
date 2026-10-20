/**
 * The password on the operator's half of the relay.
 *
 * Two failures matter and they point opposite ways. Close too much and the
 * tool stops working silently — a victim's browser cannot be asked for a
 * password, so an agent that cannot fetch /agent.js just never appears, with
 * nothing anywhere to say why. Close too little and anyone who finds the
 * address can read every recording and set a pre-payload that runs in every
 * victim browser afterwards.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COOKIE_NAME, ConsoleAuth, cookie, isVictimPath, refuse } from '../src/auth';
import { hashPassword } from '../src/passwd';

const PASSWORD = 'asdf1234!@#';
const auth = new ConsoleAuth({ password: PASSWORD });

/** A request carrying the cookie this auth would issue for `password`. */
async function signedInWith(a: ConsoleAuth, password: string, user?: string): Promise<never> {
  const header = await a.cookieFor(password, user);
  assert.ok(header, 'expected a cookie');
  return { headers: { cookie: header.slice(0, header.indexOf(';')) } } as never;
}
const signedIn = () => signedInWith(auth, PASSWORD);

/** A .passwd holding one account, at 0600, in a directory of its own. */
async function passwdFile(user: string, password: string): Promise<string> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'bxc-auth-')), '.passwd');
  writeFileSync(file, `${user}:${await hashPassword(password)}\n`);
  chmodSync(file, 0o600);
  return file;
}

/** A .passwd holding several accounts, each `user:password:id:role`. */
async function passwdWithAll(
  rows: readonly (readonly [string, string, string, 'admin' | 'member'])[],
): Promise<string> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'bxc-auth-')), '.passwd');
  const lines = await Promise.all(
    rows.map(async ([user, password, id, role]) => `${user}:${await hashPassword(password)}:${id}:${role}`),
  );
  writeFileSync(file, lines.join('\n') + '\n');
  chmodSync(file, 0o600);
  return file;
}

describe('what stays open', () => {
  // A victim's browser reaches these with nobody at the keyboard.
  for (const p of ['/agent.js', '/ping', '/ping/img/abc123', '/ping/websocket/abc123', '/ping/style/x', '/ping/script/x', '/ping/fetch/x']) {
    test(`${p} needs no password`, () => assert.equal(isVictimPath(p), true));
  }
});

describe('what is closed', () => {
  for (const p of ['/', '/index.html', '/pre-payload', '/body/s1/abc', '/asset/s1/xyz', '/agent.source.js', '/ws/console', '/assets/app.js']) {
    test(`${p} needs the password`, () => assert.equal(isVictimPath(p), false));
  }

  test('minting a ping token and checking one are the console’s, not a page’s', () => {
    /*
     * These two used to be open, along with the whole of /ping/. Nothing in a
     * page ever asks for a token — the console mints one and bakes it into
     * the snippet, and the page only fetches /ping/{probe}/{token} — so open
     * they let anyone who found the port mint tokens and sweep for live ones.
     */
    assert.equal(isVictimPath('/ping/new'), false);
    assert.equal(isVictimPath('/ping/check/tok'), false);
  });

  test('a probe route that is not a probe is closed', () => {
    // The list is what is open, so something added under /ping/ later is
    // closed without anyone remembering to close it.
    for (const p of ['/ping/newish/x', '/ping/admin/x', '/ping/tokens/x', '/ping/', '/ping/img']) {
      assert.equal(isVictimPath(p), false, p);
    }
  });

  test('a new endpoint is closed without anyone remembering to close it', () => {
    // The whole reason this lives in code: /pre-payload was added and no
    // proxy config would have known to protect it.
    assert.equal(isVictimPath('/something-added-next-month'), false);
  });

  test('a path that merely starts like a victim path is not one', () => {
    assert.equal(isVictimPath('/agent.js.map'), false);
    assert.equal(isVictimPath('/pingpong'), false);
    assert.equal(isVictimPath('/agent.json'), false);
  });
});

describe('the password', () => {
  test('the right one yields a cookie, the wrong one nothing', async () => {
    assert.ok(await auth.cookieFor(PASSWORD));
    for (const wrong of ['', 'asdf1234', 'ASDF1234!@#', 'asdf1234!@#  ', 'x']) {
      assert.equal(await auth.cookieFor(wrong), null, JSON.stringify(wrong));
    }
  });

  test('the cookie is a hash, so the password is not sitting in the browser', async () => {
    const value = (await auth.cookieFor(PASSWORD))!;
    assert.ok(!value.includes(PASSWORD));
    assert.match(value, /^__wvs=admin\.[0-9a-f]{64};/);
  });

  test('it is HttpOnly and SameSite=Strict', async () => {
    const value = (await auth.cookieFor(PASSWORD))!;
    assert.match(value, /HttpOnly/);
    assert.match(value, /SameSite=Strict/);
  });

  test('two relays with different passwords do not accept each other’s cookies', async () => {
    const other = new ConsoleAuth({ password: 'something else' });
    assert.equal(other.allows(await signedIn()), false);
  });

  test('an account name that is not ours is refused whatever the HMAC', async () => {
    const header = (await auth.cookieFor(PASSWORD))!;
    const forged = header.replace('admin.', 'root.');
    assert.equal(auth.allows({ headers: { cookie: forged.slice(0, forged.indexOf(';')) } } as never), false);
  });
});

describe('the cookie check', () => {
  test('a request with the cookie is allowed', async () => {
    assert.equal(auth.allows(await signedIn()), true);
  });

  test('no cookie, an empty one, or junk are all refused', () => {
    for (const header of [undefined, '', `${COOKIE_NAME}=`, `${COOKIE_NAME}=zzzz`, `${COOKIE_NAME}=abc`, 'other=1']) {
      assert.equal(auth.allows({ headers: { cookie: header } } as never), false, String(header));
    }
  });

  test('a cookie of the wrong length does not throw', () => {
    // timingSafeEqual rejects mismatched lengths by throwing, which would be
    // a 500 on every malformed cookie rather than a refusal.
    for (const value of ['00', 'admin.00', 'admin.', '.abc', 'admin.zz', 'a.b.c']) {
      assert.doesNotThrow(() => auth.allows({ headers: { cookie: `${COOKIE_NAME}=${value}` } } as never), value);
      assert.equal(auth.allows({ headers: { cookie: `${COOKIE_NAME}=${value}` } } as never), false, value);
    }
  });

  test('it is found among other cookies, and not confused with a similar name', () => {
    assert.equal(cookie(`a=1; ${COOKIE_NAME}=xyz; b=2`, COOKIE_NAME), 'xyz');
    assert.equal(cookie(`not${COOKIE_NAME}=xyz`, COOKIE_NAME), null);
    assert.equal(cookie(`${COOKIE_NAME}x=xyz`, COOKIE_NAME), null);
  });
});

describe('being refused', () => {
  function fakeRes() {
    const res = { code: 0, headers: {} as Record<string, string>, body: '' };
    return {
      ...res,
      writeHead(code: number, headers: Record<string, string>) {
        res.code = code;
        res.headers = headers;
        return this;
      },
      end(text: string) {
        res.body = text ?? '';
      },
      seen: () => res,
    };
  }

  test('a browser gets a sign-in page', () => {
    const res = fakeRes();
    refuse({ method: 'GET', headers: { accept: 'text/html,*/*' } } as never, res as never);
    assert.equal(res.seen().code, 401);
    assert.match(res.seen().body, /<form method="POST" action="\/login">/);
  });

  test('a fetch gets a status it can act on, not HTML to misparse', () => {
    const res = fakeRes();
    refuse({ method: 'GET', headers: { accept: 'application/json' } } as never, res as never);
    assert.equal(res.seen().code, 401);
    assert.doesNotMatch(res.seen().body, /<form/);
  });

  test('a PUT is refused without being handed a page to submit', () => {
    const res = fakeRes();
    refuse({ method: 'PUT', headers: { accept: 'text/html' } } as never, res as never);
    assert.equal(res.seen().code, 401);
    assert.doesNotMatch(res.seen().body, /<form/);
  });
});

describe('accounts from .passwd', () => {
  const made: string[] = [];
  const keep = (f: string) => (made.push(f), f);

  test('the file is used instead of CONSOLE_PASSWORD, and the env password stops working', async () => {
    const file = keep(await passwdFile('admin', 'from the file'));
    const a = new ConsoleAuth({ file, password: PASSWORD });
    a.load();
    assert.equal(a.source, 'file');
    assert.ok(await a.cookieFor('from the file'));
    assert.equal(await a.cookieFor(PASSWORD), null, 'the env password must not still work');
  });

  test('without a file it falls back, and says which it is using', () => {
    const a = new ConsoleAuth({ file: path.join(tmpdir(), 'bxc-absent', '.passwd'), password: PASSWORD });
    a.load();
    assert.equal(a.source, 'env');
    assert.equal(a.isDefault, true);
    assert.equal(new ConsoleAuth({ password: 'not the default' }).isDefault, false);
  });

  test('the account name rides in the cookie', async () => {
    const file = keep(await passwdFile('operator', 'pw for operator'));
    const a = new ConsoleAuth({ file });
    a.load();
    assert.equal(a.defaultUser(), 'operator');
    assert.match((await a.cookieFor('pw for operator'))!, /^__wvs=operator\.[0-9a-f]{64};/);
  });

  /*
   * The point of deriving the cookie from the stored line rather than from a
   * server secret. Without this a leaked cookie is good for thirty days and
   * there is nothing the operator can do about it.
   */
  test('changing the password invalidates the cookies issued under the old one', async () => {
    const file = keep(await passwdFile('admin', 'the old one'));
    const a = new ConsoleAuth({ file });
    a.load();
    const before = await signedInWith(a, 'the old one');
    assert.equal(a.allows(before), true);

    writeFileSync(file, `admin:${await hashPassword('the new one')}\n`);
    chmodSync(file, 0o600);
    await new Promise((r) => setTimeout(r, 1100)); // past the recheck throttle

    assert.equal(a.allows(before), false, 'the old cookie must stop verifying');
    assert.ok(await a.cookieFor('the new one'));
    assert.equal(await a.cookieFor('the old one'), null);
  });

  test('re-hashing the same password also invalidates it, since the salt moves', async () => {
    const file = keep(await passwdFile('admin', 'unchanged'));
    const a = new ConsoleAuth({ file });
    a.load();
    const before = await signedInWith(a, 'unchanged');

    writeFileSync(file, `admin:${await hashPassword('unchanged')}\n`);
    chmodSync(file, 0o600);
    await new Promise((r) => setTimeout(r, 1100));

    assert.equal(a.allows(before), false);
    assert.equal(a.allows(await signedInWith(a, 'unchanged')), true);
  });

  test('a file others can read stops the relay rather than being used anyway', async () => {
    const file = keep(await passwdFile('admin', 'pw'));
    chmodSync(file, 0o644);
    assert.throws(() => new ConsoleAuth({ file }).load(), /chmod 600/);
  });

  /*
   * Several accounts.
   *
   * Everything a console socket may read is decided from the account behind
   * the request, so the question stopped being "is this the operator" and
   * became "which of them is it". The cookie already carried the name; these
   * are about the answer being the right account and not merely a yes.
   */
  test('the request is a particular account, with its id and role', async () => {
    const file = keep(await passwdWithAll([['ana', 'pw for ana', 'a1a1a1', 'admin']]));
    const a = new ConsoleAuth({ file });
    a.load();
    const actor = a.actorFor(await signedInWith(a, 'pw for ana'));
    assert.equal(actor?.user, 'ana');
    assert.equal(actor?.id, 'a1a1a1', 'the id is what a project will be owned by');
    assert.equal(actor?.role, 'admin');
  });

  test('two accounts each get their own cookie, and neither answers as the other', async () => {
    const file = keep(
      await passwdWithAll([
        ['ana', 'pw for ana', 'a1a1a1', 'admin'],
        ['bo', 'pw for bo', 'b2b2b2', 'member'],
      ]),
    );
    const a = new ConsoleAuth({ file });
    a.load();
    assert.equal(a.actorFor(await signedInWith(a, 'pw for ana', 'ana'))?.user, 'ana');
    const bo = a.actorFor(await signedInWith(a, 'pw for bo', 'bo'));
    assert.equal(bo?.user, 'bo');
    assert.equal(bo?.role, 'member', 'a later account is not an administrator');
    // And one password does not open the other's account.
    assert.equal(await a.cookieFor('pw for bo', 'ana'), null);
    assert.equal(await a.cookieFor('pw for ana', 'bo'), null);
  });

  test('a password with no name is refused once there is a choice, not aimed at the first', async () => {
    /*
     * The form had no name field before there were several accounts, so an
     * empty one still means "the one account" — for a single-account file and
     * for CONSOLE_PASSWORD. With several it means nothing, and resolving it to
     * the first would point every blank attempt at whoever happens to be at
     * the top of the file.
     */
    const one = new ConsoleAuth({ file: keep(await passwdWithAll([['ana', 'pw for ana', 'a1a1a1', 'admin']])) });
    one.load();
    assert.equal(one.defaultUser(), 'ana');
    assert.ok(await one.cookieFor('pw for ana'));

    const two = new ConsoleAuth({
      file: keep(
        await passwdWithAll([
          ['ana', 'pw for ana', 'a1a1a1', 'admin'],
          ['bo', 'pw for bo', 'b2b2b2', 'member'],
        ]),
      ),
    });
    two.load();
    assert.equal(two.defaultUser(), null);
    assert.equal(await two.cookieFor('pw for ana'), null, 'a blank name must not resolve to the first account');
    assert.ok(await two.cookieFor('pw for ana', 'ana'));
  });

  test('one account changing its password leaves the others signed in', async () => {
    // The cookie is keyed on that account's own line, so a password change is
    // one person's revocation and not everybody's.
    const file = keep(
      await passwdWithAll([
        ['ana', 'pw for ana', 'a1a1a1', 'admin'],
        ['bo', 'pw for bo', 'b2b2b2', 'member'],
      ]),
    );
    const a = new ConsoleAuth({ file });
    a.load();
    const anaBefore = await signedInWith(a, 'pw for ana', 'ana');
    const boBefore = await signedInWith(a, 'pw for bo', 'bo');

    // Only ana's line is rewritten. Re-hashing bo's would move its salt and
    // so its key, which is the very thing being shown not to happen here.
    const bosLine = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('bo:'))!;
    writeFileSync(file, `ana:${await hashPassword('ana again')}:a1a1a1:admin\n${bosLine}\n`);
    chmodSync(file, 0o600);
    await new Promise((r) => setTimeout(r, 1100));

    assert.equal(a.allows(anaBefore), false, 'ana changed her password');
    assert.equal(a.allows(boBefore), true, 'bo did not');
  });

  after(() => {
    for (const f of made) rmSync(path.dirname(f), { recursive: true, force: true });
  });
});

/**
 * Changing the account list from the console.
 *
 * The same rules the CLI has, because they are the same file — and the one
 * that matters most is the refusal to remove the last administrator, since
 * doing it from the admin screen locks everybody out of the admin screen.
 *
 * All of it writes `.passwd` and lets the relay's own re-read pick it up, so
 * nothing here restarts anything. That is not a nicety: a restart drops every
 * agent socket, and the runs those pages are producing cannot be started
 * again.
 */
describe('editing accounts', () => {
  const made: string[] = [];
  const keep = (f: string) => (made.push(f), f);

  /** An auth over a file holding these accounts, loaded. */
  async function withAccounts(rows: readonly (readonly [string, string, string, 'admin' | 'member'])[]) {
    const file = keep(await passwdWithAll(rows));
    const a = new ConsoleAuth({ file });
    a.load();
    return { auth: a, file };
  }

  const names = (a: ConsoleAuth) => a.summaries().map((s) => s.user);

  test('an account is added and can sign in at once, with no restart', async () => {
    const { auth: a } = await withAccounts([['ana', 'pw for ana', 'a1a1a1', 'admin']]);
    assert.equal(await a.changeAccounts({ op: 'create', user: 'bo', password: 'pw for bo', role: 'member' }), null);
    assert.deepEqual(names(a), ['ana', 'bo']);
    assert.ok(await a.cookieFor('pw for bo', 'bo'), 'the new account cannot sign in');
    assert.equal(a.summaries().find((s) => s.user === 'bo')?.role, 'member');
  });

  test('the list the console is shown is the one on disk, not the one from a second ago', async () => {
    /*
     * The file is re-read at most once a second, so the list straight after a
     * write was the list from before it — the account was added, the file was
     * right, and the screen showed no change. The write reloads past the
     * throttle for exactly this.
     */
    const { auth: a } = await withAccounts([['ana', 'pw for ana', 'a1a1a1', 'admin']]);
    await a.changeAccounts({ op: 'create', user: 'bo', password: 'pw for bo', role: 'member' });
    assert.deepEqual(names(a), ['ana', 'bo'], 'the console would have been sent the old list');
  });

  test('a name that is taken, a name that is not usable, a password that is too short', async () => {
    const { auth: a } = await withAccounts([['ana', 'pw for ana', 'a1a1a1', 'admin']]);
    assert.match((await a.changeAccounts({ op: 'create', user: 'ana', password: 'another one', role: 'member' })) ?? '', /already an account/);
    assert.match((await a.changeAccounts({ op: 'create', user: 'a b', password: 'long enough', role: 'member' })) ?? '', /not a usable account name/);
    assert.match((await a.changeAccounts({ op: 'create', user: 'bo', password: 'short', role: 'member' })) ?? '', /at least 8/);
    assert.deepEqual(names(a), ['ana'], 'a refusal must not have written anything');
  });

  test('removing the last administrator is refused, from here as from the CLI', async () => {
    const { auth: a } = await withAccounts([
      ['ana', 'pw for ana', 'a1a1a1', 'admin'],
      ['bo', 'pw for bo', 'b2b2b2', 'member'],
    ]);
    assert.match((await a.changeAccounts({ op: 'remove', user: 'ana' })) ?? '', /last administrator/);
    assert.deepEqual(names(a), ['ana', 'bo']);

    // And the same for demoting one, which leaves none just as surely.
    assert.match((await a.changeAccounts({ op: 'setRole', user: 'ana', role: 'member' })) ?? '', /last administrator/);
    assert.equal(a.summaries().find((s) => s.user === 'ana')?.role, 'admin');
  });

  test('with another administrator both go through', async () => {
    const { auth: a } = await withAccounts([
      ['ana', 'pw for ana', 'a1a1a1', 'admin'],
      ['bo', 'pw for bo', 'b2b2b2', 'member'],
    ]);
    assert.equal(await a.changeAccounts({ op: 'setRole', user: 'bo', role: 'admin' }), null);
    assert.equal(await a.changeAccounts({ op: 'remove', user: 'ana' }), null);
    assert.deepEqual(names(a), ['bo']);
  });

  test('removing an account leaves its id behind, which is what a transfer is for', async () => {
    const { auth: a } = await withAccounts([
      ['ana', 'pw for ana', 'a1a1a1', 'admin'],
      ['bo', 'pw for bo', 'b2b2b2', 'member'],
    ]);
    await a.changeAccounts({ op: 'remove', user: 'bo' });
    assert.ok(!a.accountIds().has('b2b2b2'), 'a project owned by bo now names an id with no account');
  });

  test('a password set from here keeps the id, so the projects stay owned', async () => {
    const { auth: a } = await withAccounts([
      ['ana', 'pw for ana', 'a1a1a1', 'admin'],
      ['bo', 'pw for bo', 'b2b2b2', 'member'],
    ]);
    const before = await signedInWith(a, 'pw for bo', 'bo');
    assert.equal(await a.changeAccounts({ op: 'setPassword', user: 'bo', password: 'reset by ana' }), null);

    assert.equal(a.summaries().find((s) => s.user === 'bo')?.id, 'b2b2b2', 'the id moved and took the projects with it');
    assert.equal(a.allows(before), false, 'the old cookie still worked');
    assert.ok(await a.cookieFor('reset by ana', 'bo'));
    assert.equal(await a.cookieFor('pw for ana', 'ana') !== null, true, 'ana was signed out too');
  });

  test('an account that is not there is said so, whichever thing was asked', async () => {
    const { auth: a } = await withAccounts([['ana', 'pw for ana', 'a1a1a1', 'admin']]);
    for (const change of [
      { op: 'remove' as const, user: 'nobody' },
      { op: 'setRole' as const, user: 'nobody', role: 'admin' as const },
      { op: 'setPassword' as const, user: 'nobody', password: 'long enough' },
    ]) {
      assert.match((await a.changeAccounts(change)) ?? '', /no account called/, change.op);
    }
  });

  test('a relay with no file says so rather than pretending to write one', async () => {
    // CONSOLE_PASSWORD gives one synthetic account and nowhere to put a
    // second; an admin screen whose every button failed would be worse.
    const a = new ConsoleAuth({ password: 'from the environment' });
    assert.equal(a.canEditAccounts, false);
    assert.match((await a.changeAccounts({ op: 'create', user: 'bo', password: 'long enough', role: 'member' })) ?? '', /npm run passwd/);
  });

  test('what the console is shown never contains a credential', async () => {
    const { auth: a } = await withAccounts([['ana', 'pw for ana', 'a1a1a1', 'admin']]);
    assert.deepEqual(a.summaries(), [{ id: 'a1a1a1', user: 'ana', role: 'admin' }]);
    assert.ok(!JSON.stringify(a.summaries()).includes('scrypt'));
  });

  after(() => {
    for (const f of made) rmSync(path.dirname(f), { recursive: true, force: true });
  });
});
