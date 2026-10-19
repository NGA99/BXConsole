/**
 * The overview strip above the requests table: every request as a bar on a
 * shared time axis, DOMContentLoaded (blue) and Load (red) markers, and a
 * drag selection that filters the table to requests active in that range.
 */
import { useRef, useState, type PointerEvent } from 'react';
import type { NetworkEntry, PageTiming } from '../../state/session-data';
import { formatMs } from './classify';
import { timelineOf } from './timing';
import { niceStep } from '../../devtools-ui/scale';

const LANES = 6;

export function Overview({
  entries,
  range,
  timing,
  selection,
  onSelect,
}: {
  entries: NetworkEntry[];
  range: { min: number; max: number };
  timing: PageTiming;
  selection: { min: number; max: number } | null;
  onSelect: (sel: { min: number; max: number } | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const span = range.max - range.min;
  const pct = (t: number) => `${((t - range.min) / span) * 100}%`;

  const toTime = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return range.min + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const t = toTime(e.clientX);
    setDrag({ start: t, end: t });
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ ...drag, end: toTime(e.clientX) });
  };
  const onUp = () => {
    if (!drag) return;
    const min = Math.min(drag.start, drag.end);
    const max = Math.max(drag.start, drag.end);
    onSelect(max - min < span * 0.005 ? null : { min, max });
    setDrag(null);
  };

  const sel = drag ? { min: Math.min(drag.start, drag.end), max: Math.max(drag.start, drag.end) } : selection;
  const step = niceStep(span / 6);
  const ticks: number[] = [];
  for (let t = step; t < span; t += step) ticks.push(t);

  return (
    <div className="overview" ref={ref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} title="Drag to filter by time">
      {ticks.map((t) => (
        <span key={t} className="overview-tick" style={{ left: `${(t / span) * 100}%` }}>
          {formatMs(t)}
        </span>
      ))}
      {entries.map((e, i) => {
        const t = timelineOf(e);
        const end = t.end ?? range.max;
        return (
          <div
            key={e.requestId}
            className={`overview-bar${e.failed ? ' failed' : ''}`}
            style={{ left: pct(t.start), width: `calc(${((end - t.start) / span) * 100}% + 1px)`, top: 16 + (i % LANES) * 6 }}
          />
        );
      })}
      {timing.domContentLoaded && <div className="overview-marker dcl" style={{ left: pct(timing.domContentLoaded) }} />}
      {timing.load && <div className="overview-marker load" style={{ left: pct(timing.load) }} />}
      {sel && <div className="overview-selection" style={{ left: pct(sel.min), width: `${((sel.max - sel.min) / span) * 100}%` }} />}
      {selection && !drag && (
        <button className="overview-clear" onClick={(e) => { e.stopPropagation(); onSelect(null); }} onPointerDown={(e) => e.stopPropagation()}>
          ✕ clear range
        </button>
      )}
    </div>
  );
}

