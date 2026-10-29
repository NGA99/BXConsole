/** A WebSocket's or EventSource's frames, and the one selected spelled out. */
import { useState } from 'react';
import type { NetworkEntry, WsFrame } from '../../../state/session-data';
import { tryParseJson } from '../json-to-serialized';
import { clockTime } from '../../../devtools-ui/time';

function prettyIfJson(text: string): string {
  const v = tryParseJson(text);
  return v === undefined ? text : JSON.stringify(v, null, 2);
}

export function MessagesTab({ entry }: { entry: NetworkEntry }) {
  const [filter, setFilter] = useState('');
  // Hold the frame itself: an index into the filtered list would point at a
  // different message once the filter changes or the 500-frame cap slides.
  const [selected, setSelected] = useState<WsFrame | null>(null);
  const frames = (entry.frames ?? []).filter((f) => !filter || f.data.includes(filter));
  const current = selected && frames.includes(selected) ? selected : undefined;
  return (
    <div className="ws-messages">
      <div className="detail-bar">
        <input className="field toolbar-input" placeholder="Filter messages" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="detail-note">
          {entry.frames?.length ?? 0} messages{entry.closed ? ` · closed ${entry.closed.code}${entry.closed.reason ? ` ${entry.closed.reason}` : ''}` : ''}
        </span>
      </div>
      <table className="ws-table mono">
        <thead>
          <tr>
            <th>Data</th>
            <th className="num">Length</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {frames.map((f, i) => (
            <tr key={i} className={`${f.direction}${selected === f ? ' selected' : ''}`} onClick={() => setSelected(f)}>
              <td>
                <span className="ws-arrow">{f.direction === 'sent' ? '↑' : '↓'}</span> {f.data.slice(0, 200)}
              </td>
              <td className="num">{f.length}</td>
              <td className="num">{clockTime(f.ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {current && <pre className="detail-pre ws-detail">{prettyIfJson(current.data)}{current.truncated ? '\n… (truncated)' : ''}</pre>}
    </div>
  );
}
