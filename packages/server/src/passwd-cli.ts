/**
 * `npm run passwd -- [user]` — set the operator's password.
 *
 * A CLI and not a line in the README telling people to hash a string
 * themselves, because a password nobody can change easily is a password
 * nobody changes. The relay re-reads the file, so this takes effect without a
 * restart and without dropping a live session.
 */
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PASSWORD_MIN_LENGTH } from '@bxconsole/protocol';
import { type Account, FIRST_ACCOUNT_ID, PasswordFile, hashPassword, newAccountId, writeAccounts } from './passwd';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const file = process.env.PASSWD_FILE ?? path.join(repoRoot, '.passwd');

/** The minimum that makes the scrypt cost worth anything. */

/**
 * Reading the answers, as one paused line iterator.
 *
 * Two simpler shapes did not survive a piped stdin. A fresh interface per
 * question dies with the stream when the first one closes. One shared
 * interface with `question()` loses the second line: between the first
 * callback and the next `question()` there is a microtask gap, and readline
 * emits into it with nobody listening. The async iterator pauses the stream
 * between pulls, so a line cannot arrive before something is waiting for it.
 */
let rl: Interface | null = null;
let lines: AsyncIterator<string> | null = null;

/** Prompt without echoing, so the password stays out of the terminal's scrollback. */
async function ask(prompt: string): Promise<string> {
  rl ??= createInterface({
    input: process.stdin,
    output: process.stdout,
    // Only a real terminal needs the cursor handling, and only a real
    // terminal echoes what is typed in the first place.
    terminal: process.stdin.isTTY === true,
  });
  lines ??= rl[Symbol.asyncIterator]();

  process.stdout.write(prompt);
  const out = process.stdout as unknown as { write: (s: string) => boolean };
  const write = out.write.bind(out);
  out.write = () => true; // swallow the echo
  try {
    const next = await lines.next();
    return next.done ? '' : next.value.trim();
  } finally {
    out.write = write;
    process.stdout.write('\n');
  }
}

function fail(message: string): never {
  console.error(message);
  rl?.close();
  process.exit(1);
}

/** What is in the file already, or nothing when there is no file yet. */
async function readExisting(): Promise<Account[]> {
  try {
    await fs.access(file);
  } catch {
    return [];
  }
  try {
    const loaded = new PasswordFile(file);
    loaded.loadOrThrow();
    // All of them. Returning the first used to be enough, and writing the
    // file back from that would now delete everyone else.
    return [...loaded.all()];
  } catch (err) {
    // A file we cannot read is a file we must not silently overwrite.
    return fail((err as Error).message);
  }
}

/** `--list`, `--remove <user>`, `--pin-ids`: the ones that need no password. */
async function withoutPassword(args: string[]): Promise<boolean> {
  const existing = await readExisting();

  if (args.includes('--list')) {
    if (!existing.length) {
      console.log('No accounts yet.');
      return true;
    }
    for (const a of existing) console.log(`${a.user.padEnd(20)} ${a.role.padEnd(7)} ${a.id}`);
    return true;
  }

  /*
   * Write the ids down instead of deriving them.
   *
   * A file written before ids existed gets one derived from each name as it
   * is read. That is stable, so nothing breaks — but it means a name deleted
   * and made again later would come back owning the first holder's projects.
   * Pinning writes the id each account already has, so ownership does not
   * move; what changes is that the next account of that name draws a fresh
   * one instead of inheriting.
   */
  if (args.includes('--pin-ids')) {
    if (!existing.length) {
      console.log('No accounts to pin.');
      return true;
    }
    await writeAccounts(file, existing);
    console.log(`Wrote down the ids of ${existing.length} account(s); they are unchanged. No restart needed.`);
    return true;
  }

  const removeAt = args.indexOf('--remove');
  if (removeAt >= 0) {
    const who = args[removeAt + 1];
    if (!who) fail('--remove needs an account name.');
    const gone = existing.find((a) => a.user === who);
    if (!gone) fail(`There is no account called "${who}".`);
    const left = existing.filter((a) => a.user !== who);
    // Locking everyone out is not a thing to do by accident.
    if (!left.some((a) => a.role === 'admin')) fail(`"${who}" is the last administrator; make another one first.`);
    await writeAccounts(file, left);
    console.log(`Removed "${who}". Their cookies stop working at once; no restart needed.`);
    console.log('Any projects they owned keep their id as the owner until an administrator reassigns them.');
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (await withoutPassword(args)) return;

  const roleAt = args.indexOf('--role');
  const wanted = roleAt >= 0 ? args[roleAt + 1] : undefined;
  if (wanted !== undefined && wanted !== 'admin' && wanted !== 'member') {
    fail(`"${wanted}" is not a role — expected admin or member.`);
  }
  const user = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--role' && args[i - 1] !== '--remove') ?? 'admin';

  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    fail(`"${user}" is not a usable account name (letters, digits, dot, dash, underscore).`);
  }

  const existing = await readExisting();
  const mine = existing.find((a) => a.user === user);
  const already = mine !== undefined;

  const password = await ask(`New password for "${user}": `);
  if (password.length < PASSWORD_MIN_LENGTH) fail(`Too short — use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password !== (await ask('Again: '))) fail('They do not match.');

  const account: Account = {
    user,
    record: await hashPassword(password),
    /*
     * A password change keeps the id: the projects it owns are the same ones.
     * The very first account of a relay keeps the id the environment-password
     * account had, so that the projects made before `.passwd` existed are
     * still this person's — see FIRST_ACCOUNT_ID.
     */
    id: mine?.id ?? (existing.length === 0 ? FIRST_ACCOUNT_ID : newAccountId()),
    // The first account has to be able to add the others.
    role: (wanted as Account['role'] | undefined) ?? mine?.role ?? (existing.length === 0 ? 'admin' : 'member'),
  };
  // In place, so changing a password does not reshuffle the file — and so
  // `--list` reads the same way before and after.
  const next = already ? existing.map((a) => (a.user === user ? account : a)) : [...existing, account];
  await writeAccounts(file, next);
  const shown = path.relative(process.cwd(), file) || file;
  console.log(`${already ? 'Changed' : 'Wrote'} "${user}" in ${shown} (mode 600).`);
  console.log(
    already
      ? 'Every cookie issued under the old password is now invalid. No restart needed.'
      : 'CONSOLE_PASSWORD is no longer used. No restart needed.',
  );
  rl?.close();
}

await main();
