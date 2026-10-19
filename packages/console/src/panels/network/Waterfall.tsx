/** Waterfall column cell + header time scale. */
import { useEffect, useRef, useState } from 'react';
import type { NetworkEntry } from '../../state/session-data';
import { formatMs } from './classify';
import { timelineOf, type Phase } from './timing';
import { niceStep } from '../../devtools-ui/scale';

export function WaterfallCell({ entry, range }: { entry: NetworkEntry; range: { min: number; max: number } }) {
  const t = timelineOf(entry);
  const span = range.max - range.min;
  const pct = (ms: number) => `${((ms - range.min) / span) * 100}%`;
  const end = t.end ?? range.max;
  const total = end - t.start;

  const title = [
    `Started at ${formatMs(t.start - range.min)}`,
    ...t.phases.map((p) => `${p.label}: ${formatMs(p.end - p.start)}`),
    `Total: ${t.end ? formatMs(total) : 'pending'}`,
  ].join('\n');

  return (
    <div className="waterfall-cell" title={title}>
      {t.phases.length === 0 ? (
        <div className="waterfall-bar pending" style={{ left: pct(t.start), width: pct(end - t.start + range.min) }} />
      ) : (
        t.phases.map((p, i) => (
          <div
            key={i}
            className={`waterfall-bar ${p.id}`}
            style={{ left: pct(p.start), width: `calc(${pct(p.end - p.start + range.min)} + 1px)` }}
          />
        ))
      )}
    </div>
  );
}

export function WaterfallHeader({ range }: { range: { min: number; max: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const span = range.max - range.min;
  // one label per ~70px, none when the column is too narrow for even one
  const count = Math.max(0, Math.floor(width / 70));
  const step = count ? niceStep(span / (count + 1)) : Infinity;
  const ticks: number[] = [];
  for (let t = step; t < span * 0.92; t += step) ticks.push(t);
  return (
    <div className="waterfall-header" ref={ref}>
      {ticks.map((t) => (
        <span key={t} className="waterfall-tick" style={{ left: `${(t / span) * 100}%` }}>
          {formatMs(t)}
        </span>
      ))}
    </div>
  );
}


export const PHASE_COLORS: Record<Phase['id'], string> = {
  queueing: 'var(--sys-color-token-subtle)',
  dns: '#1c9d8f',
  connect: '#e8710a',
  ssl: '#a142f4',
  request: '#8ab4f8',
  waiting: '#34a853',
  download: '#4285f4',
};
