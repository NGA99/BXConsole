/** Computed tab: every computed property, filterable, with the box model on top like DevTools. */
import { useState } from 'react';
import type { ElementStyles } from '@bxconsole/protocol';
import { BoxModelView } from './BoxModel';

export function ComputedPane({ styles }: { styles: ElementStyles | null }) {
  const [filter, setFilter] = useState('');
  if (!styles) return <div className="dom-empty">Select an element to see its computed styles.</div>;
  const f = filter.trim().toLowerCase();
  // k is lowercased as well: custom properties keep their original case.
  const list = styles.computed
    .filter(([k, v]) => !f || k.toLowerCase().includes(f) || v.toLowerCase().includes(f))
    .sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="styles-pane">
      <div className="styles-filter">
        <input className="toolbar-input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="detail-note">{list.length} properties</span>
      </div>
      <div className="styles-list mono">
        <BoxModelView box={styles.box} />
        {list.map(([k, v]) => (
          <div key={k} className="computed-row">
            <span className="computed-name">{k}</span>
            <span className="computed-value" title={v}>
              {v}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
