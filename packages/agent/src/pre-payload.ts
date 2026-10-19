/**
 * The script the relay hands every agent, run once at install.
 *
 * It runs *after* the hooks, which is the whole design: anything it fetches
 * lands in the Network tab with its response body, anything it logs lands in
 * the Console tab, and the operator needs no result channel of their own. A
 * window that is open for eight seconds has usually closed before anyone has
 * opened a console to type into, so this is the only way to take something
 * from it deliberately.
 *
 * What it returns is marked into History, so a bare expression — the common
 * case, `document.cookie` — is worth writing on its own.
 */
import { mark } from './hooks/history';
import type { Transport } from './transport';

/** The History entry the result lands under. */
export const PRE_PAYLOAD_MARK = 'pre-payload';

export function runPrePayload(transport: Transport, source: string | null | undefined): void {
  if (!source || !source.trim()) return;
  try {
    // Indirect eval, so it runs in global scope the way the console's own
    // evaluation does rather than closing over the agent's internals.
    const result = (0, eval)(source) as unknown;
    if (result === undefined) return;
    // A promise is the usual shape — `fetch(...).then(...)` — so its value is
    // worth waiting for rather than marking "[object Promise]".
    if (isThenable(result)) {
      void result.then(
        (value) => mark(transport, PRE_PAYLOAD_MARK, value),
        (err) => mark(transport, PRE_PAYLOAD_MARK, { error: String(err) }),
      );
      return;
    }
    mark(transport, PRE_PAYLOAD_MARK, result);
  } catch (err) {
    // A bad pre-payload must cost its own result and nothing else: the run it
    // was attached to is usually the only chance at that page.
    mark(transport, PRE_PAYLOAD_MARK, { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}

function isThenable(v: unknown): v is Promise<unknown> {
  return typeof (v as { then?: unknown })?.then === 'function';
}
