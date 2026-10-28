/** Styles tab: element.style, matched rules in cascade order, inherited blocks; overridden declarations struck through. */
import { useMemo, useState } from 'react';
import type { Declaration, ElementStyles, MatchedRule } from '@bxconsole/protocol';
import { computeWinners, isWinner } from './cascade';
import { BoxModelView } from './BoxModel';

export function StylesPane({ styles, onSelectAncestor }: { styles: ElementStyles | null; onSelectAncestor: (id: number) => void }) {
  const [filter, setFilter] = useState('');
  const winners = useMemo(() => (styles ? computeWinners(styles) : new Map()), [styles]);
  if (!styles) return <div className="dom-empty">Select an element to see its styles.</div>;
  const f = filter.trim().toLowerCase();
  // The name is lowercased too: a custom property keeps the case it was
  // written in, so --myColor never matched a typed "mycolor".
  const show = (d: Declaration) => !f || d.name.toLowerCase().includes(f) || d.value.toLowerCase().includes(f);

  return (
    <div className="styles-pane">
      <div className="styles-filter">
        <input className="field toolbar-input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {styles.unreadableSheets > 0 && (
          <span className="detail-note" title="Cross-origin stylesheets without CORS cannot be read from the page">
            {styles.unreadableSheets} sheet{styles.unreadableSheets > 1 ? 's' : ''} unreadable
          </span>
        )}
      </div>
      <div className="styles-list mono">
        <RuleBlock selector="element.style" source="" decls={styles.inline} blockKey="inline" winners={winners} show={show} />
        {styles.rules.map((r, i) => (
          <RuleBlock key={i} selector={r.selector} source={r.source} media={r.media} decls={r.declarations} blockKey={String(i)} winners={winners} show={show} />
        ))}
        {styles.inherited.map((inh, i) => (
          <div key={`inh${i}`} className="styles-inherited">
            <div className="styles-inherited-head">
              Inherited from{' '}
              <button className="detail-link" disabled={inh.fromId === null} onClick={() => inh.fromId !== null && onSelectAncestor(inh.fromId)}>
                {inh.from}
              </button>
            </div>
            {inh.inline.length > 0 && <RuleBlock selector="element.style" source="" decls={inh.inline} blockKey={`inherited:${i}:inline`} winners={winners} show={show} />}
            {inh.rules.map((r, j) => (
              <RuleBlock key={j} selector={r.selector} source={r.source} media={r.media} decls={r.declarations} blockKey={`inherited:${i}:${j}`} winners={winners} show={show} />
            ))}
          </div>
        ))}
        <BoxModelView box={styles.box} />
      </div>
    </div>
  );
}

function RuleBlock({
  selector,
  source,
  media,
  decls,
  blockKey,
  winners,
  show,
}: {
  selector: string;
  source: string;
  media?: string | undefined;
  decls: Declaration[];
  blockKey: string;
  winners: ReturnType<typeof computeWinners>;
  show: (d: Declaration) => boolean;
}) {
  const visible = decls.filter(show);
  if (!visible.length && decls.length) return null;
  return (
    <div className="styles-rule">
      {media && <div className="styles-media">{media}</div>}
      <div className="styles-rule-head">
        <span className="styles-selector">{selector}</span> {'{'}
        <span className="styles-source" title={source}>
          {shortSource(source)}
        </span>
      </div>
      {decls.map((d, index) =>
        show(d) ? (
          <div key={index} className={`styles-decl${isWinner(winners, blockKey, index, d.name) ? '' : ' overridden'}`}>
            <span className="tok-property">{d.name}</span>: <span className="styles-value">{d.value}</span>
            {d.important && <span className="styles-important"> !important</span>};
          </div>
        ) : null,
      )}
      <div>{'}'}</div>
    </div>
  );
}

function shortSource(src: string): string {
  if (!src) return '';
  try {
    const u = new URL(src);
    return u.pathname.split('/').filter(Boolean).pop() ?? u.host;
  } catch {
    return src;
  }
}

export type { MatchedRule };
