/**
 * The History tab's unified timeline model.
 *
 * Everything the session recorded is projected into one time-ordered list of
 * items on a handful of lanes. Console and Network keep their own buffers, so
 * this module reads those rather than duplicating them; only the recordings
 * that exist for History alone (interactions, marks, perf, DOM density) come
 * from the session's `history` buffer.
 */
import { entryTab, type ConsoleEntry, type HistoryEntry, type NetworkEntry, type PageTiming } from '../../state/session-data';
import { severityOf } from '../console/group-tree';
import { plainText, formatValue } from '../console/format';
import { nameOf, durationOf, statusLabel } from '../network/classify';

export type LaneId = 'navigation' | 'interaction' | 'network' | 'console' | 'dom' | 'perf' | 'marks';

export interface Lane {
  id: LaneId;
  label: string;
  /** CSS colour for markers on this lane */
  color: string;
  /** lanes beyond the first five are opt-in, so the default view stays readable */
  defaultOn: boolean;
}

export const LANES: Lane[] = [
  { id: 'navigation', label: 'Navigation', color: 'var(--hist-navigation)', defaultOn: true },
  { id: 'interaction', label: 'Interaction', color: 'var(--hist-interaction)', defaultOn: true },
  { id: 'network', label: 'Network', color: 'var(--hist-network)', defaultOn: true },
  { id: 'console', label: 'Console', color: 'var(--hist-console)', defaultOn: true },
  { id: 'marks', label: 'Marks', color: 'var(--hist-marks)', defaultOn: true },
  { id: 'dom', label: 'DOM', color: 'var(--hist-dom)', defaultOn: false },
  { id: 'perf', label: 'Perf', color: 'var(--hist-perf)', defaultOn: false },
];

export interface HistItem {
  id: string;
  ts: number;
  /** which window of the session it happened in */
  tabId?: string;
  lane: LaneId;
  /** short type label shown as the row's badge */
  kind: string;
  label: string;
  detail?: string;
  severity?: 'error' | 'warning';
  /** drawn as a bar of this length (ms) instead of a tick */
  durationMs?: number;
  /** DOM lane bar height driver */
  weight?: number;
  /** where this item lives in another tab */
  reveal?: { panel: 'console'; seq: number } | { panel: 'network'; requestId: string };
}

export interface BuildInput {
  history: HistoryEntry[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  pageTiming: PageTiming;
  /** load milestones per window, so a run with several windows gets a marker for each */
  timingByTab?: Record<string, PageTiming>;
}

/** One time-ordered list across every lane. */
export function buildItems({ history, console: consoleEntries, network, pageTiming, timingByTab }: BuildInput): HistItem[] {
  const items: HistItem[] = [];

  // One pair of markers per window; sessions recorded before windows existed
  // have a single unkeyed timing instead.
  const timings: Array<[string | undefined, PageTiming]> = timingByTab && Object.keys(timingByTab).length > 0 ? Object.entries(timingByTab) : [[undefined, pageTiming]];
  for (const [tabId, t] of timings) {
    const suffix = tabId ?? 'all';
    if (t.domContentLoaded) {
      items.push({ id: `timing-dcl-${suffix}`, ts: t.domContentLoaded, lane: 'navigation', kind: 'DCL', label: 'DOMContentLoaded', ...(tabId ? { tabId } : {}) });
    }
    if (t.load) {
      items.push({ id: `timing-load-${suffix}`, ts: t.load, lane: 'navigation', kind: 'Load', label: 'Load event', ...(tabId ? { tabId } : {}) });
    }
  }

  for (const e of history) items.push({ ...historyItem(e), ...(e.tabId ? { tabId: e.tabId } : {}) });

  for (const e of consoleEntries) {
    const item = consoleItem(e);
    if (item) items.push({ ...item, ...(entryTab(e) ? { tabId: entryTab(e) } : {}) });
  }

  for (const e of network) {
    const failed = !!e.failed;
    const status = e.response?.status;
    const bad = failed || (status !== undefined && status >= 400);
    items.push({
      id: `net-${e.requestId}`,
      ts: e.request.ts,
      lane: 'network',
      kind: e.resource ? (e.request.initiator ?? 'resource') : e.request.method,
      label: nameOf(e.request.url),
      detail: `${statusLabel(e)} · ${e.request.url}`,
      ...(bad ? { severity: 'error' as const } : {}),
      ...(e.tabId ? { tabId: e.tabId } : {}),
      ...(durationOf(e) !== undefined ? { durationMs: durationOf(e)! } : {}),
      reveal: { panel: 'network', requestId: e.requestId },
    });
  }

  items.sort((a, b) => a.ts - b.ts);
  // Labels, details and badges are built out of page-supplied fields, and the
  // panel renders them as React children: an object there is React error #31
  // and takes the whole panel down. Coerced once, here, rather than at each of
  // the twenty places an item is made.
  return items.map(asText);
}

/** The strings of one item, actually as strings. */
function asText(item: HistItem): HistItem {
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  return {
    ...item,
    kind: str(item.kind),
    label: str(item.label),
    ...(item.detail === undefined ? {} : { detail: str(item.detail) }),
    ts: typeof item.ts === 'number' && Number.isFinite(item.ts) ? item.ts : 0,
  };
}

function historyItem(e: HistoryEntry): HistItem {
  const id = `h-${e.seq}`;
  switch (e.type) {
    case 'page.navigated':
      return {
        id,
        ts: e.ts,
        lane: 'navigation',
        kind: e.kind === 'load' ? 'load' : 'route',
        label: e.kind === 'load' ? `Navigated to ${e.url}` : `Route change to ${e.url}`,
        detail: e.title,
      };
    case 'page.title':
      return { id, ts: e.ts, lane: 'navigation', kind: 'title', label: e.title };
    case 'interaction.click':
      return {
        id,
        ts: e.ts,
        lane: 'interaction',
        kind: 'click',
        label: e.text ? `Click “${e.text}”` : `Click ${e.tag}`,
        detail: `${e.selector} at ${e.x}, ${e.y}`,
      };
    case 'interaction.input':
      return { id, ts: e.ts, lane: 'interaction', kind: 'input', label: `${shortSelector(e.selector)} = ${e.value || '(empty)'}`, detail: e.selector };
    case 'interaction.key':
      return { id, ts: e.ts, lane: 'interaction', kind: 'key', label: e.key, detail: e.selector };
    case 'interaction.scroll':
      return { id, ts: e.ts, lane: 'interaction', kind: 'scroll', label: `Scrolled to ${e.x}, ${e.y}` };
    case 'interaction.submit':
      return { id, ts: e.ts, lane: 'interaction', kind: 'submit', label: `Submit ${shortSelector(e.selector)}`, detail: [e.method, e.action].filter(Boolean).join(' ') };
    case 'perf.longtask':
      return { id, ts: e.ts, lane: 'perf', kind: 'long task', label: `${e.durationMs} ms blocked`, durationMs: e.durationMs, severity: e.durationMs >= 200 ? 'error' : 'warning' };
    case 'perf.layoutShift':
      return { id, ts: e.ts, lane: 'perf', kind: 'shift', label: `score ${e.value}`, detail: e.hadRecentInput ? 'after recent input' : 'unexpected', ...(e.value >= 0.1 && !e.hadRecentInput ? { severity: 'warning' as const } : {}) };
    case 'perf.paint':
      return { id, ts: e.ts, lane: 'perf', kind: paintLabel(e.name), label: `${e.startTime} ms after load start` };
    case 'dom.activity':
      return { id, ts: e.ts, lane: 'dom', kind: 'dom', label: `${e.mutations} mutations`, detail: `+${e.added} / −${e.removed} nodes`, weight: e.mutations };
    case 'mark.custom':
      return { id, ts: e.ts, lane: 'marks', kind: 'mark', label: e.name, ...(e.data ? { detail: formatValue(e.data) } : {}) };
  }
}

function consoleItem(e: ConsoleEntry): HistItem | null {
  const sev = severityOf(e);
  switch (e.type) {
    case 'console.message':
      return {
        id: `c-${e.seq}`,
        ts: e.ts,
        lane: 'console',
        kind: e.level,
        label: plainText(e.args).slice(0, 300) || '(empty)',
        ...(sev === 'error' || sev === 'warning' ? { severity: sev } : {}),
        reveal: { panel: 'console', seq: e.seq },
      };
    case 'error.uncaught':
      return { id: `c-${e.seq}`, ts: e.ts, lane: 'console', kind: 'error', label: e.message, severity: 'error', reveal: { panel: 'console', seq: e.seq } };
    case 'error.unhandledrejection':
      return { id: `c-${e.seq}`, ts: e.ts, lane: 'console', kind: 'rejection', label: formatValue(e.reason), severity: 'error', reveal: { panel: 'console', seq: e.seq } };
    case 'eval.command':
      return { id: `c-${e.seq}`, ts: e.ts, lane: 'console', kind: 'eval', label: e.expression, reveal: { panel: 'console', seq: e.seq } };
    default:
      // console.clear, eval.result, network.error (the request itself is on the Network lane)
      return null;
  }
}

function paintLabel(name: string): string {
  if (name === 'first-contentful-paint') return 'FCP';
  if (name === 'first-paint') return 'FP';
  if (name === 'largest-contentful-paint') return 'LCP';
  return name;
}

/** Last step of a selector, which is the part that identifies the element. */
export function shortSelector(sel: string): string {
  // The page chose this, so it is a string only by type. A number here used to
  // throw out of the History render and take the panel down with it.
  const text = typeof sel === 'string' ? sel : sel === null || sel === undefined ? '' : String(sel);
  const parts = text.split(' > ');
  return parts[parts.length - 1] ?? text;
}

export function summarize(items: HistItem[]): Record<LaneId, number> {
  const counts = { navigation: 0, interaction: 0, network: 0, console: 0, dom: 0, perf: 0, marks: 0 } as Record<LaneId, number>;
  for (const i of items) counts[i.lane]++;
  return counts;
}
