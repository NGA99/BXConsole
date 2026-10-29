/** When it started and ended, and the phases between, drawn to scale. */
import type { NetworkEntry } from '../../../state/session-data';
import { formatMs } from '../classify';
import { timelineOf, shownTiming } from '../timing';
import { PHASE_COLORS } from '../Waterfall';
import { fullTimestamp } from '../../../devtools-ui/time';
import { Section, KV, Empty } from './bits';

export function TimingTab({ entry }: { entry: NetworkEntry }) {
  const t = timelineOf(entry);
  if (t.end === null) return <Empty>Request is still pending.</Empty>;
  const shown = shownTiming({ ...t, end: t.end });
  // The bars are positions rather than printed figures, so they are drawn
  // from the unrounded span; `|| 1` keeps a request that took no measurable
  // time from dividing by zero.
  const span = t.end - t.start || 1;
  const pct = (ms: number) => `${(ms / span) * 100}%`;

  return (
    <div className="detail-sections">
      <Section title="Started">
        <KV name="Start Time" value={fullTimestamp(shown.start)} />
        <KV name="End Time" value={fullTimestamp(shown.end)} />
      </Section>
      <Section title={`Duration: ${formatMs(shown.total)}`}>
        <table className="timing-table">
          <tbody>
            {t.phases.map((p, i) => (
              <tr key={i}>
                <td className="timing-label">{p.label}</td>
                <td className="timing-bar-cell">
                  <div
                    className="timing-bar"
                    style={{ left: pct(p.start - t.start), width: pct(p.end - p.start), background: PHASE_COLORS[p.id] }}
                  />
                </td>
                <td className="timing-value">{formatMs(p.end - p.start)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="detail-note">
          {!entry.resource && 'Phases before "Waiting" (DNS, connect) are not observable from fetch/XHR.'}
          {entry.resource && !entry.resource.timing?.requestStart && 'Detailed phases need a Timing-Allow-Origin header from the server.'}
        </div>
      </Section>
    </div>
  );
}
