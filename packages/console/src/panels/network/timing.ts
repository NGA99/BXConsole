/**
 * Phases of a request on the epoch-ms timeline, for the waterfall column and
 * the Timing tab. fetch/XHR know start / headers-arrived / end; resource
 * timing entries can add DNS, connect and SSL when the server allows it.
 */
import type { NetworkEntry } from '../../state/session-data';

export interface Phase {
  id: 'queueing' | 'dns' | 'connect' | 'ssl' | 'request' | 'waiting' | 'download';
  label: string;
  start: number;
  end: number;
}

export interface Timeline {
  start: number;
  /** null while pending */
  end: number | null;
  phases: Phase[];
}

export function timelineOf(entry: NetworkEntry): Timeline {
  const start = entry.request.ts;

  if (entry.resource) {
    const r = entry.resource;
    const end = start + r.duration;
    const t = r.timing;
    const toEpoch = (perf: number) => start + (perf - r.startTime);

    if (t && t.requestStart > 0 && t.responseStart > 0) {
      const phases: Phase[] = [];
      const push = (id: Phase['id'], label: string, s: number, e: number) => {
        if (e > s) phases.push({ id, label, start: toEpoch(s), end: toEpoch(e) });
      };
      push('queueing', 'Queueing', r.startTime, t.fetchStart);
      if (t.domainLookupStart > 0) push('dns', 'DNS Lookup', t.domainLookupStart, t.domainLookupEnd);
      if (t.connectStart > 0) {
        push('connect', 'Initial connection', t.connectStart, t.secureConnectionStart > 0 ? t.secureConnectionStart : t.connectEnd);
        if (t.secureConnectionStart > 0) push('ssl', 'SSL', t.secureConnectionStart, t.connectEnd);
      }
      // "Request sent" has no end marker in Resource Timing; it is folded into Waiting (TTFB).
      push('waiting', 'Waiting for server response', t.requestStart, t.responseStart);
      push('download', 'Content Download', t.responseStart, t.responseEnd);
      return { start, end, phases };
    }
    return { start, end, phases: [{ id: 'waiting', label: 'Waiting for server response', start, end }] };
  }

  const end = entry.finished ? start + entry.finished.durationMs : entry.failed ? entry.failed.ts : null;
  const wait = entry.response?.waitMs;
  if (end === null) return { start, end, phases: [] };
  if (wait !== undefined && wait < end - start) {
    return {
      start,
      end,
      phases: [
        { id: 'waiting', label: 'Waiting for server response', start, end: start + wait },
        { id: 'download', label: 'Content Download', start: start + wait, end },
      ],
    };
  }
  return { start, end, phases: [{ id: 'waiting', label: 'Waiting for server response', start, end }] };
}

/** Overall range of a list of entries, for scaling the waterfall. */
export function rangeOf(entries: NetworkEntry[], origin?: number, now = Date.now()): { min: number; max: number } {
  let min = origin ?? Infinity;
  let max = -Infinity;
  for (const e of entries) {
    const t = timelineOf(e);
    if (t.start < min) min = t.start;
    const end = t.end ?? now;
    if (end > max) max = end;
  }
  if (!Number.isFinite(min)) return { min: now, max: now + 1 };
  if (origin !== undefined) {
    for (const [, t] of [[0, origin]] as Array<[number, number]>) if (t > max) max = t;
  }
  return { min, max: Math.max(max, min + 1) };
}
