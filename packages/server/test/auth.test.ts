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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COOKIE_NAME, ConsoleAuth, cookie, isVictimPath, refuse } from '../src/auth';
import { hashPassword } from '../src/passwd';

const PASSWORD = 'asdf1234!@#';
const auth = new ConsoleAuth({ password: PASSWORD });

/** A request carrying the cookie this auth would issue for `password`. */
async function signedInWith(a: ConsoleAuth, password: string): Promise<never> {
  const header = await a.cookieFor(password);
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

describe('what stays open', () => {
  // A victim's browser reaches these with nobody at the keyboard.
  for (const p of ['/agent.js', '/ping', '/ping/new', '/ping/img/abc123', '/ping/websocket/abc123', '/ping/check/tok']) {
    test(`${p} needs no password`, () => assert.equal(isVictimPath(p), true));
  }
});

describe('what is closed', () => {
  for (const p of ['/', '/index.html', '/pre-payload', '/body/s1/abc', '/asset/s1/xyz', '/agent.source.js', '/ws/console', '/assets/app.js']) {
    test(`${p} needs the password`, () => assert.equal(isVictimPath(p), false));
  }

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
    assert.equal(a.userName(), 'operator');
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

  after(() => {
    for (const f of made) rmSync(path.dirname(f), { recursive: true, force: true });
  });
});
