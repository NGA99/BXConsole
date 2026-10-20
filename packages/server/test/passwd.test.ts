/**
 * The password file.
 *
 * Three things here are load-bearing and each has a way of failing quietly:
 * the hash has to be a real scrypt hash and not a SHA-256 wearing its name,
 * the file has to be re-read when it changes or a password change needs a
 * restart and a restart ends every live run, and a file others can read has
 * to stop the relay rather than be used anyway.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PasswordFile,
  PasswdError,
  accountFromEnv,
  hashPassword,
  verifyPassword,
  writeAccounts, derivedId } from '../src/passwd';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'bxc-passwd-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a .passwd and give it back, at 0600 unless told otherwise. */
function passwd(body: string, mode = 0o600): string {
  const file = path.join(tmp(), '.passwd');
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

describe('hashing', () => {
  test('a password verifies against its own hash and nothing else', async () => {
    const record = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', record), true);
    for (const wrong of ['', 'correct horse batter', 'Correct Horse Battery', 'x']) {
      assert.equal(await verifyPassword(wrong, record), false, JSON.stringify(wrong));
    }
  });

  test('it is scrypt with the cost written in, so the cost can be raised later', async () => {
    assert.match(await hashPassword('p'), /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  });

  test('two hashes of one password differ, so the file does not reveal reuse', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  test('a malformed record is refused rather than throwing', async () => {
    for (const record of [
      '',
      'nonsense',
      'scrypt$',
      'scrypt$16384$8$1$$',
      'scrypt$16384$8$1$aa',
      'sha256$16384$8$1$aa$bb',
      'scrypt$notanumber$8$1$aa$bb',
      'scrypt$0$8$1$aa$bb',
    ]) {
      assert.equal(await verifyPassword('p', record), false, JSON.stringify(record));
    }
  });

  test('a record demanding absurd cost is refused instead of hanging', async () => {
    // Without the ceiling this would try to allocate its way to a timeout.
    const t0 = Date.now();
    assert.equal(await verifyPassword('p', 'scrypt$1073741824$8$1$aa$bb'), false);
    assert.ok(Date.now() - t0 < 2000, 'should refuse immediately');
  });
});

describe('reading the file', () => {
  test('one account, comments and blank lines', async () => {
    const record = await hashPassword('pw');
    const file = passwd(`# a comment\n\nadmin:${record}\n`);
    const f = new PasswordFile(file);
    f.loadOrThrow();
    assert.equal(f.isMissing, false);
    assert.equal(f.all()[0]?.user, 'admin');
    assert.equal(f.find('admin')?.record, record);
    assert.equal(f.find('nobody'), null);
  });

  test('an absent file is missing, not an error — the relay falls back', () => {
    const f = new PasswordFile(path.join(tmp(), 'nope'));
    f.loadOrThrow();
    assert.equal(f.isMissing, true);
    assert.deepEqual(f.all(), []);
  });

  test('a file others can read stops the relay', async () => {
    const file = passwd(`admin:${await hashPassword('pw')}\n`, 0o644);
    const f = new PasswordFile(file);
    assert.throws(() => f.loadOrThrow(), PasswdError);
    // And the message has to be the fix, not a complaint.
    assert.throws(() => f.loadOrThrow(), /chmod 600/);
  });

  test('a line without a hash names the command that makes one', () => {
    const file = passwd('admin:hunter2\n');
    assert.throws(() => new PasswordFile(file).loadOrThrow(), /npm run passwd -- admin/);
  });

  test('a malformed line, a bad name, a repeated name, an empty file', async () => {
    const record = await hashPassword('pw');
    for (const [body, pattern] of [
      ['adminnocolon\n', /expected "user:hash"/],
      [`:${record}\n`, /expected "user:hash"/],
      [`ad min:${record}\n`, /not a usable account name/],
      [`admin:${record}\nadmin:${record}\n`, /appears twice/],
      ['# only a comment\n', /no accounts/],
      ['\n\n', /no accounts/],
    ] as const) {
      assert.throws(() => new PasswordFile(passwd(body)).loadOrThrow(), pattern, body);
    }
  });

  test('every account in the file is granted, not just the first', async () => {
    // This used to assert the opposite — one account honoured and the rest
    // refused with a warning — because that is all the relay could do with
    // them. They are the people who log in now.
    const record = await hashPassword('pw');
    const file = passwd(`admin:${record}:aaaaaa:admin\nsecond:${record}:bbbbbb:member\n`);
    const f = new PasswordFile(file);
    f.loadOrThrow();
    assert.equal(f.find('admin')?.id, 'aaaaaa');
    assert.equal(f.find('second')?.id, 'bbbbbb', 'the second account is still being refused');
    assert.equal(f.find('second')?.role, 'member');
  });

  test('a file written before ids says so rather than failing', async () => {
    /*
     * The deployed file is two fields: `user:hash`. It has to go on working,
     * because the relay reads it at boot and a relay that will not boot drops
     * every live run. The id is derived from the name meanwhile, which is
     * stable across restarts, and the warning says how to pin it.
     */
    const record = await hashPassword('pw');
    const warnings: string[] = [];
    const f = new PasswordFile(passwd(`admin:${record}\n`), (m) => warnings.push(m));
    f.loadOrThrow();
    assert.equal(f.find('admin')?.user, 'admin');
    assert.equal(f.find('admin')?.id, derivedId('admin'));
    assert.equal(f.find('admin')?.role, 'admin', 'an old single-account file is the administrator');
    assert.match(warnings.join('\n'), /--pin-ids/);
  });

  test('a file with ids but no roles makes the first one the operator, the rest members', async () => {
    /*
     * Roles are the last field, so a hand-written file can stop before them.
     * Defaulting the lot to admin was the first thing this did, which made
     * everyone in the file an administrator — including on a file written to
     * add somebody with less than that.
     */
    const record = await hashPassword('pw');
    const f = new PasswordFile(passwd(`admin:${record}:aaaaaa\nsecond:${record}:bbbbbb\nthird:${record}:cccccc\n`));
    f.loadOrThrow();
    assert.equal(f.find('admin')?.role, 'admin');
    assert.equal(f.find('second')?.role, 'member');
    assert.equal(f.find('third')?.role, 'member');
  });

  test('a two-account file from before ids reads, with ids derived for both', async () => {
    // All of them lacking an id is one scheme, not a half-migration.
    const record = await hashPassword('pw');
    const warnings: string[] = [];
    const f = new PasswordFile(passwd(`admin:${record}\nsecond:${record}\n`), (m) => warnings.push(m));
    f.loadOrThrow();
    assert.equal(f.find('admin')?.id, derivedId('admin'));
    assert.equal(f.find('second')?.id, derivedId('second'));
    assert.match(warnings.join('\n'), /admin, second/, 'the warning names both');
  });

  test('a half-migrated file is refused rather than guessed at', async () => {
    // Some lines with ids and some without means two schemes at once, and
    // deriving the missing ones would hand out ownership by coincidence.
    const record = await hashPassword('pw');
    const body = `admin:${record}:aaaaaa:admin\nsecond:${record}\n`;
    assert.throws(() => new PasswordFile(passwd(body)).loadOrThrow(), /--pin-ids/);
  });

  test('a role that is not one of the two is refused', async () => {
    const record = await hashPassword('pw');
    assert.throws(() => new PasswordFile(passwd(`admin:${record}:aaaaaa:owner\n`)).loadOrThrow(), /expected admin or member/);
  });
});

describe('reloading', () => {
  /** The file is re-read at most once a second, so move its mtime and wait. */
  function age(file: string): void {
    const past = new Date(Date.now() - 5000);
    utimesSync(file, past, past);
  }

  test('a changed file is picked up without a restart', async () => {
    const first = await hashPassword('first');
    const file = passwd(`admin:${first}\n`);
    age(file);
    const warnings: string[] = [];
    const f = new PasswordFile(file, (m) => warnings.push(m));
    f.loadOrThrow();
    assert.equal(f.all()[0]?.record, first);

    const second = await hashPassword('second');
    writeFileSync(file, `admin:${second}\n`);
    chmodSync(file, 0o600);
    await new Promise((r) => setTimeout(r, 1100)); // past the recheck throttle

    assert.equal(f.all()[0]?.record, second, 'should have re-read the file');
    assert.match(warnings.join('\n'), /reloaded/);
  });

  test('a file broken mid-save keeps serving the last good one', async () => {
    const good = await hashPassword('pw');
    const file = passwd(`admin:${good}\n`);
    age(file);
    const warnings: string[] = [];
    const f = new PasswordFile(file, (m) => warnings.push(m));
    f.loadOrThrow();

    // An editor that has written the name and not yet the hash.
    writeFileSync(file, 'admin:');
    chmodSync(file, 0o600);
    await new Promise((r) => setTimeout(r, 1100));

    assert.equal(f.all()[0]?.record, good, 'a half-written file must not lock the operator out');
    assert.match(warnings.join('\n'), /not reloaded/);
  });

  test('a file that disappears falls back and says so', async () => {
    const file = passwd(`admin:${await hashPassword('pw')}\n`);
    age(file);
    const warnings: string[] = [];
    const f = new PasswordFile(file, (m) => warnings.push(m));
    f.loadOrThrow();
    rmSync(file);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(f.isMissing, true);
    assert.match(warnings.join('\n'), /CONSOLE_PASSWORD/);
  });
});

describe('writing the file', () => {
  test('it lands at 0600 and reads back', async () => {
    const file = path.join(tmp(), '.passwd');
    const record = await hashPassword('pw');
    await writeAccounts(file, [{ user: 'admin', record, id: 'aaaaaa', role: 'admin' }]);
    const f = new PasswordFile(file);
    f.loadOrThrow(); // would throw on the mode
    assert.equal(f.all()[0]?.user, 'admin');
  });

  test('an existing loose file is tightened rather than left as it was', async () => {
    const file = passwd('# old\n', 0o644);
    await writeAccounts(file, [{ user: 'admin', record: await hashPassword('pw'), id: 'aaaaaa', role: 'admin' as const }]);
    assert.doesNotThrow(() => new PasswordFile(file).loadOrThrow());
  });
});

describe('the env fallback', () => {
  test('its record changes with the password and never contains it', () => {
    const a = accountFromEnv('admin', 'one');
    const b = accountFromEnv('admin', 'two');
    assert.notEqual(a.record, b.record);
    assert.ok(!a.record.includes('one'));
  });
});
