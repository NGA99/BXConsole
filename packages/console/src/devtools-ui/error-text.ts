/**
 * One line about a render failure, for the operator rather than for a log.
 *
 * Whatever React hands a boundary is as untrusted as the data that caused it:
 * a thrown string, an object with no message, a message with newlines in it.
 * The boundary renders this as text, so the only job here is to always come
 * back with one short readable line.
 */

const MAX = 200;

export function describeError(err: unknown): string {
  const text = messageOf(err);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'An error with no message.';
  return oneLine.length > MAX ? `${oneLine.slice(0, MAX)}…` : oneLine;
}

/**
 * `Name: message`, or whichever of them says something.
 *
 * A name on its own is worth printing when it was chosen — `RelayDown` tells
 * the reader where to look. Plain `Error` does not, so a message-less one
 * falls through to the sentence rather than putting the word "Error" on screen
 * as though it were the problem.
 */
function named(name: unknown, message: unknown): string {
  const m = typeof message === 'string' ? message.trim() : '';
  const n = typeof name === 'string' && name.trim() !== 'Error' ? name.trim() : '';
  if (m && n) return `${n}: ${m}`;
  return m || n;
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return named(err.name, err.message);
  if (err && typeof err === 'object') {
    const o = err as { name?: unknown; message?: unknown };
    if (typeof o.message === 'string' || typeof o.name === 'string') {
      return named(o.name, o.message);
    }
    // Nothing message-shaped. Naming the type is more use than "[object Object]".
    return `A ${(err as object).constructor?.name ?? 'value'} was thrown.`;
  }
  if (err === null) return 'null was thrown.';
  if (err === undefined) return '';
  return `${String(err)} was thrown.`;
}
