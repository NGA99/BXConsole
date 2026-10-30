/**
 * Turn the flat, seq-ordered entry list into the row tree the panel renders:
 * console.group opens a nesting level, identical adjacent messages collapse
 * into one row with a repeat count, and filters prune the tree.
 */
import type { ConsoleEntry } from '../../state/session-data';
import { plainText } from './format';

export interface Row {
  key: string;
  entry: ConsoleEntry;
  repeat: number;
  /** present only for group headers */
  children?: Row[];
}

export type Severity = 'verbose' | 'info' | 'warning' | 'error';

export interface LevelFilter {
  verbose: boolean;
  info: boolean;
  warning: boolean;
  error: boolean;
}

export const DEFAULT_LEVELS: LevelFilter = { verbose: false, info: true, warning: true, error: true };
export const ALL_LEVELS: LevelFilter = { verbose: true, info: true, warning: true, error: true };

export function buildTree(entries: ConsoleEntry[], groupSimilar: boolean): Row[] {
  const root: Row[] = [];
  const stack: Row[][] = [root];

  for (const entry of entries) {
    // groupDepth comes from the page: a string here used to leave the stack
    // where it was, so later rows nested under a group that never opened.
    const reported = entry.type === 'console.message' ? entry.groupDepth : undefined;
    const depth = typeof reported === 'number' && Number.isFinite(reported) ? Math.max(0, Math.trunc(reported)) : stack.length - 1;
    while (stack.length - 1 > depth) stack.pop();
    const siblings = stack[stack.length - 1]!;

    if (entry.type === 'console.message') {
      if (entry.level === 'groupEnd') continue;
      if (entry.level === 'group' || entry.level === 'groupCollapsed') {
        const row: Row = { key: String(entry.seq), entry, repeat: 1, children: [] };
        siblings.push(row);
        stack.push(row.children!);
        continue;
      }
    }

    const last = siblings[siblings.length - 1];
    if (groupSimilar && last && !last.children && sameMessage(last.entry, entry)) {
      last.repeat += 1;
      continue;
    }
    siblings.push({ key: String(entry.seq), entry, repeat: 1 });
  }
  return root;
}

export function severityOf(entry: ConsoleEntry): Severity {
  switch (entry.type) {
    case 'console.message':
      switch (entry.level) {
        case 'debug':
          return 'verbose';
        case 'warn':
          return 'warning';
        case 'error':
        case 'assert':
          return 'error';
        default:
          return 'info';
      }
    case 'error.uncaught':
    case 'error.unhandledrejection':
    case 'network.error':
      return 'error';
    case 'eval.result':
      return entry.exception ? 'error' : 'info';
    case 'eval.command':
    case 'console.clear':
    case 'page.navigated':
      return 'info';
  }
}

export function filterTree(rows: Row[], levels: LevelFilter, text: string): Row[] {
  const matcher = compileText(text);
  const out: Row[] = [];
  for (const row of rows) {
    if (row.children) {
      const children = filterTree(row.children, levels, text);
      if (children.length || (matcher(rowText(row)) && text)) out.push({ ...row, children });
      continue;
    }
    // Prompt echo/result and "cleared" always show, like DevTools.
    const sticky =
      row.entry.type === 'eval.command' ||
      row.entry.type === 'eval.result' ||
      row.entry.type === 'console.clear' ||
      row.entry.type === 'page.navigated';
    if (!sticky && !levels[severityOf(row.entry)]) continue;
    if (!matcher(rowText(row))) continue;
    out.push(row);
  }
  return out;
}

/**
 * What the row says, for the filter to search.
 *
 * It has to be the text on the screen, and three rows say a word the entry
 * does not carry: the error rows write their own `Uncaught` and `Uncaught (in
 * promise)`, and a thrown expression at the prompt writes `Uncaught` too.
 * Leaving those out meant `in promise` — the first thing a reader types to
 * pull rejections out of a long log — matched nothing, while the uncaught row
 * beside it matched only because pages tend to put the word in `message`
 * themselves. Two rows that read alike on screen answered differently.
 */
export function rowText(row: Row): string {
  const e = row.entry;
  switch (e.type) {
    case 'console.message':
      return plainText(e.args);
    case 'error.uncaught':
      // The row prepends its own `Uncaught` and strips the page's, so this
      // reads the same whichever way the page phrased it, and never twice.
      // Blocks are joined by the line breaks they are drawn with.
      return [
        `Uncaught ${String(e.message ?? '').replace(/^Uncaught\s+/, '')}`,
        e.stack,
        e.cause && `Caused by: ${plainText([e.cause])}`,
      ]
        .filter(Boolean)
        .join('\n');
    case 'error.unhandledrejection':
      return `Uncaught (in promise) ${plainText([e.reason])}`;
    case 'eval.command':
      return e.expression;
    case 'eval.result':
      return `${e.exception ? 'Uncaught ' : ''}${plainText([e.exception ?? e.result ?? { t: 'undefined' }])}`;
    case 'console.clear':
      return '';
    case 'page.navigated':
      return `Navigated to ${e.url}`;
    case 'network.error':
      return `${e.method} ${e.url} ${e.status ?? ''} ${e.statusText ?? e.error ?? ''}`;
  }
}

/** DevTools filter syntax, the useful subset: plain substring, `-exclude`, `/regex/`. */
function compileText(text: string): (s: string) => boolean {
  const terms = text.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  const tests = terms.map((term) => {
    const negate = term.startsWith('-') && term.length > 1;
    const body = negate ? term.slice(1) : term;
    let test: (s: string) => boolean;
    const re = /^\/(.+)\/([a-z]*)$/.exec(body);
    if (re) {
      try {
        const rx = new RegExp(re[1]!, re[2]);
        test = (s) => rx.test(s);
      } catch {
        test = (s) => s.includes(body);
      }
    } else {
      const lower = body.toLowerCase();
      test = (s) => s.toLowerCase().includes(lower);
    }
    return negate ? (s: string) => !test(s) : test;
  });
  return (s) => tests.every((t) => t(s));
}

function sameMessage(a: ConsoleEntry, b: ConsoleEntry): boolean {
  if (a.type !== 'console.message' || b.type !== 'console.message') return false;
  if (a.level !== b.level || a.groupDepth !== b.groupDepth) return false;
  if (a.stack !== b.stack) return false;
  return JSON.stringify(stripIds(a.args)) === JSON.stringify(stripIds(b.args));
}

function stripIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (k !== 'id') out[k] = stripIds(val);
    return out;
  }
  return v;
}
