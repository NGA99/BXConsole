/**
 * Searching inside the requests, as a pane beside them.
 *
 * The filter above the list decides which rows are listed; this looks inside
 * them — headers, payloads, response bodies, websocket frames — and that is a
 * different question with a different shape of answer. A flat list of matches
 * was the wrong shape: a reader is looking for a request, and what makes a
 * match worth following is which request it was in, so the matches are
 * grouped under it and the request is the thing you click.
 */
import { useMemo, useState, type RefObject } from 'react';
import { Toolbar, ToolbarInput } from '../../devtools-ui/Toolbar';
import type { NetworkEntry } from '../../state/session-data';
import type { SearchHit, SearchResult } from './search';
import { hostOf } from './filters';
import './NetworkSearch.css';

/** Matches past this in one request fold behind a "Show N more". */
const PER_REQUEST = 10;

export function NetworkSearch({
  query,
  onQuery,
  opts,
  onOpts,
  result,
  entries,
  loadingBodies,
  onSearchStored,
  onPick,
  onClose,
  inputRef,
}: {
  query: string;
  onQuery: (v: string) => void;
  opts: { regex: boolean; caseSensitive: boolean };
  onOpts: (v: { regex: boolean; caseSensitive: boolean }) => void;
  result: SearchResult;
  entries: NetworkEntry[];
  loadingBodies: boolean;
  onSearchStored: () => void;
  onPick: (requestId: string) => void;
  onClose: () => void;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const { hits, unloaded } = result;
  const byId = useMemo(() => new Map(entries.map((e) => [e.requestId, e])), [entries]);

  /** Matches keep the order they were found in, which is the order of the run. */
  const groups = useMemo(() => {
    const out: Array<{ requestId: string; hits: SearchHit[] }> = [];
    const index = new Map<string, number>();
    for (const h of hits) {
      const at = index.get(h.requestId);
      if (at === undefined) {
        index.set(h.requestId, out.length);
        out.push({ requestId: h.requestId, hits: [h] });
      } else {
        out[at]!.hits.push(h);
      }
    }
    return out;
  }, [hits]);

  return (
    <div className="netsearch">
      <div className="netsearch-head">
        <span className="netsearch-title">Search</span>
        <button className="netsearch-close" title="Close search" onClick={onClose}>
          ✕
        </button>
      </div>
      <Toolbar>
        <ToolbarInput inputRef={inputRef} placeholder="Find" value={query} onChange={onQuery} />
        <label className="toolbar-check" title="Treat the query as a regular expression">
          <input type="checkbox" checked={opts.regex} onChange={(e) => onOpts({ ...opts, regex: e.target.checked })} /> .*
        </label>
        <label className="toolbar-check" title="Match case">
          <input type="checkbox" checked={opts.caseSensitive} onChange={(e) => onOpts({ ...opts, caseSensitive: e.target.checked })} /> Aa
        </label>
      </Toolbar>

      {/*
        A recording keeps its larger bodies in the relay's store. Saying so is
        the whole point: "No matches" that quietly skipped the only place the
        answer was is worse than no search at all.
      */}
      {query && unloaded.length > 0 && (
        <div className="netsearch-note">
          {loadingBodies ? (
            <>Reading {unloaded.length} stored {unloaded.length === 1 ? 'body' : 'bodies'}…</>
          ) : (
            <>
              {unloaded.length} recorded {unloaded.length === 1 ? 'body is' : 'bodies are'} held by the relay and were not searched.{' '}
              <button className="detail-link" onClick={onSearchStored}>
                Search them too
              </button>
            </>
          )}
        </div>
      )}

      <div className="netsearch-results">
        {!query && (
          <div className="netsearch-empty">
            <strong>No search results</strong>
            <span>Type to search headers, payloads and responses</span>
          </div>
        )}
        {query && groups.length === 0 && (
          <div className="netsearch-empty">
            <strong>No search results</strong>
            <span>{unloaded.length > 0 ? 'Nothing matched in what was searched' : 'Nothing matched'}</span>
          </div>
        )}
        {groups.map((g) => (
          <Group key={g.requestId} group={g} entry={byId.get(g.requestId)} query={query} opts={opts} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function Group({
  group,
  entry,
  query,
  opts,
  onPick,
}: {
  group: { requestId: string; hits: SearchHit[] };
  entry: NetworkEntry | undefined;
  query: string;
  opts: { regex: boolean; caseSensitive: boolean };
  onPick: (requestId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const shown = all ? group.hits : group.hits.slice(0, PER_REQUEST);
  const rest = group.hits.length - shown.length;
  const url = entry?.request.url ?? '';

  return (
    <div className="netsearch-group">
      <div className="netsearch-group-head" onClick={() => setOpen((o) => !o)}>
        <span className={`netsearch-caret${open ? ' open' : ''}`}>▾</span>
        <span className="netsearch-file" title={url}>
          {nameOf(url) || group.requestId}
        </span>
        <span className="netsearch-host">{hostOf(url)}</span>
        <span className="netsearch-count">{group.hits.length}</span>
      </div>
      {open && (
        <>
          {shown.map((h, i) => (
            <div key={i} className="netsearch-line" onClick={() => onPick(group.requestId)} title={`${h.where} — click to show the request`}>
              <span className="netsearch-label">
                <Marked text={h.label} query={query} opts={opts} />:
              </span>
              <span className="netsearch-value mono">
                <Marked text={h.snippet} query={query} opts={opts} />
              </span>
            </div>
          ))}
          {rest > 0 && (
            <button className="netsearch-more" onClick={() => setAll(true)}>
              Show {rest} more
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The matched text, picked out of the line it sits in.
 *
 * The same expression the search ran, so what is highlighted is what matched
 * rather than a second guess at it. A query that is not a valid expression
 * cannot have matched anything, so there is nothing to mark.
 */
function Marked({ text, query, opts }: { text: string; query: string; opts: { regex: boolean; caseSensitive: boolean } }) {
  const parts = useMemo(() => {
    if (!query) return [text];
    let rx: RegExp;
    try {
      rx = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
    } catch {
      return [text];
    }
    const out: Array<string | { hit: string }> = [];
    let at = 0;
    for (const m of text.matchAll(rx)) {
      if (m.index === undefined) continue;
      // A pattern that can match nothing would otherwise loop on one spot.
      if (m[0] === '') break;
      if (m.index > at) out.push(text.slice(at, m.index));
      out.push({ hit: m[0] });
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }, [text, query, opts.regex, opts.caseSensitive]);

  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i}>{p.hit}</mark>))}
    </>
  );
}

function nameOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() ?? '(index)';
  } catch {
    return url;
  }
}
