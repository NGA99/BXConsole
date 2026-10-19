/**
 * window.onerror / unhandledrejection -> error.* events.
 * These show up in the Console tab as red entries, same as in DevTools.
 *
 * Both listeners run inside the page's own error handling, so nothing here may
 * throw: serialising a rejection reason runs page-controlled traps, and an
 * exception from here would surface as a second, confusing error in the page.
 */
import { serialize } from '../serialize';
import type { Transport } from '../transport';

export function installErrorHook(transport: Transport): void {
  window.addEventListener('error', (ev) => {
    try {
      const err = ev.error instanceof Error ? ev.error : null;
      const cause = err ? (err as Error & { cause?: unknown }).cause : undefined;
      transport.send({
        type: 'error.uncaught',
        ts: Date.now(),
        message: ev.message,
        stack: err?.stack ?? undefined,
        ...(cause !== undefined ? { cause: serialize(cause) } : {}),
        source: ev.filename,
        line: ev.lineno,
        col: ev.colno,
      });
    } catch {
      /* the page's own error handling must not be disturbed */
    }
  });

  window.addEventListener('unhandledrejection', (ev) => {
    try {
      transport.send({ type: 'error.unhandledrejection', ts: Date.now(), reason: serialize(ev.reason) });
    } catch {
      /* as above */
    }
  });
}
