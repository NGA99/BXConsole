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
import { type Account, PasswordFile, hashPassword, writeAccounts } from './passwd';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const file = process.env.PASSWD_FILE ?? path.join(repoRoot, '.passwd');

/** The minimum that makes the scrypt cost worth anything. */
const MIN_LENGTH = 8;

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
    const one = loaded.only();
    return one ? [one] : [];
  } catch (err) {
    // A file we cannot read is a file we must not silently overwrite.
    return fail((err as Error).message);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const user = args.find((a) => !a.startsWith('--')) ?? 'admin';

  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    fail(`"${user}" is not a usable account name (letters, digits, dot, dash, underscore).`);
  }

  const existing = await readExisting();
  const already = existing.some((a) => a.user === user);
  if (!already && existing.length > 0 && !replace) {
    fail(
      `Only one account is supported yet, and "${existing[0]!.user}" already exists.\n` +
        `  Change that one:  npm run passwd -- ${existing[0]!.user}\n` +
        `  Or swap it out:   npm run passwd -- ${user} --replace`,
    );
  }

  const password = await ask(`New password for "${user}": `);
  if (password.length < MIN_LENGTH) fail(`Too short — use at least ${MIN_LENGTH} characters.`);
  if (password !== (await ask('Again: '))) fail('They do not match.');

  await writeAccounts(file, [{ user, record: await hashPassword(password) }]);
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
