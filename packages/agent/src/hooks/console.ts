/**
 * Patches `console.*` so every call is forwarded as `console.message` while
 * still reaching the real console.
 *
 * Mirrors what DevTools does with the raw call:
 *   - every message carries a stack so the UI can show the call site
 *   - assert only logs when the condition is falsy
 *   - count / time* are turned into their rendered text here, since the
 *     counters live in the page
 *   - group depth is tracked so the UI can nest without replaying state
 */
import type { ConsoleLevel } from '@bxconsole/protocol';
import type { AgentConfig } from '../config';
import { serialize } from '../serialize';
import { captureStack } from '../stack';
import type { Transport } from '../transport';

const LEVELS: ConsoleLevel[] = [
  'log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table',
  'group', 'groupCollapsed', 'groupEnd', 'assert', 'count', 'countReset',
  'time', 'timeEnd', 'timeLog',
];

type AnyFn = (...args: unknown[]) => void;

export function installConsoleHook(transport: Transport, config: AgentConfig): void {
  const con = console as unknown as Record<string, unknown>;
  const original: Partial<Record<ConsoleLevel, AnyFn>> = {};
  const counters = new Map<string, number>();
  const timers = new Map<string, number>();
  let groupDepth = 0;

  const emit = (level: ConsoleLevel, args: unknown[]) => {
    // Nothing here may escape into the page. Serialising runs page-controlled
    // traps (a proxy's ownKeys, a class's constructor name), and a throw would
    // come out of the page's own console.log call site, not ours.
    try {
      transport.send({
        type: 'console.message',
        ts: Date.now(),
        level,
        args: args.map((a) => serialize(a)),
        groupDepth,
        stack: captureStack(config),
      });
    } catch {
      /* the page keeps working; this one message is lost */
    }
  };

  for (const level of LEVELS) {
    const fn = con[level];
    if (typeof fn !== 'function') continue;
    original[level] = fn as AnyFn;

    con[level] = (...args: unknown[]) => {
      original[level]?.apply(console, args);

      switch (level) {
        case 'groupEnd':
          groupDepth = Math.max(0, groupDepth - 1);
          emit('groupEnd', []);
          return;
        case 'group':
        case 'groupCollapsed':
          emit(level, args.length ? args : ['console.group']);
          groupDepth += 1;
          return;
        case 'assert':
          if (args[0]) return;
          emit('assert', ['Assertion failed', ...args.slice(1)]);
          return;
        case 'count': {
          const label = labelOf(args[0]);
          const n = (counters.get(label) ?? 0) + 1;
          counters.set(label, n);
          emit('count', [`${label}: ${n}`]);
          return;
        }
        case 'countReset':
          counters.delete(labelOf(args[0]));
          return;
        case 'time':
          timers.set(labelOf(args[0]), performance.now());
          return;
        case 'timeEnd':
        case 'timeLog': {
          const label = labelOf(args[0]);
          const start = timers.get(label);
          if (start === undefined) {
            emit('warn', [`Timer '${label}' does not exist`]);
            return;
          }
          const ms = performance.now() - start;
          if (level === 'timeEnd') timers.delete(label);
          emit(level, [`${label}: ${ms.toFixed(3)} ms`, ...(level === 'timeLog' ? args.slice(1) : [])]);
          return;
        }
        case 'trace':
          emit('trace', args.length ? args : ['console.trace']);
          return;
        default:
          emit(level, args);
      }
    };
  }

  const originalClear = console.clear.bind(console);
  console.clear = () => {
    originalClear();
    transport.send({ type: 'console.clear', ts: Date.now() });
  };
}

function labelOf(v: unknown): string {
  return v === undefined ? 'default' : String(v);
}
