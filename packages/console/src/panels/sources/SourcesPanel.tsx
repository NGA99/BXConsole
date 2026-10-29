/**
 * Sources tab (read-only): navigator of the page's document, scripts and
 * stylesheets grouped by host; a viewer with line numbers, highlighting,
 * find-in-file and pretty print. Location links elsewhere (console rows,
 * stack frames, network initiators) open a file here at a line.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceEntry, SourceText } from '@bxconsole/protocol';
import { sourcesList, sourceText } from '../../transport/client';
import { useSourcesTarget } from '../../state/sources-target';
import { useSessionsStore } from '../../state/sessions';
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarInput } from '../../devtools-ui/Toolbar';
import { CodeView, canFormat, detectLanguage, formatCode, type CodeLanguage } from '../../devtools-ui/CodeView';
import { SourceTree } from './SourceTree';
import { SplitView } from '../../devtools-ui/SplitView';
import { hostOf } from '../network/filters';
import { fileName } from '../../devtools-ui/file-name';
import './SourcesPanel.css';

/** Cleared on every document load: after a reload the files are new. */
const textCache = new Map<string, SourceText>();

export function SourcesPanel({ sessionId }: { sessionId: string }) {
  const connected = useSessionsStore((s) => s.byId[sessionId]?.connected ?? false);
  const session = useSessionsStore((s) => s.byId[sessionId]);
  const target = useSourcesTarget((s) => s.target);
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [navOpen, setNavOpen] = useState(true);
  const [current, setCurrent] = useState<string | null>(null);
  const [source, setSource] = useState<SourceText | null>(null);
  const [loading, setLoading] = useState(false);
  const [pretty, setPretty] = useState(false);
  const [wrap, setWrap] = useState(false);
  // Two line numbers, because they are measured against different text: a
  // link from the Console or Network tab points into the file as served, while
  // a find match points into what is on screen. Pretty print only invalidates
  // the first, so keeping them apart is what lets find work while it is on.
  const [targetLine, setTargetLine] = useState<number | undefined>(undefined);
  const [findLine, setFindLine] = useState<number | undefined>(undefined);
  const [find, setFind] = useState('');
  const [findIdx, setFindIdx] = useState(-1);
  const findRef = useRef<HTMLInputElement>(null);

  const refreshList = () => {
    // Asked even when the page is gone: the relay keeps what the run fetched
    // and answers from that, so a recording's files stay readable afterwards.
    // Drop the cached text too: after a reload the page serves new files, and
    // re-listing alone would keep showing the old ones.
    for (const key of [...textCache.keys()]) if (key.startsWith(`${sessionId}|`)) textCache.delete(key);
    // Merge, so files opened from links (not reported by the page) survive a refresh that lands later.
    void sourcesList(sessionId).then((list) =>
      setEntries((prev) => {
        const urls = new Set(list.map((e) => e.url));
        return [...list, ...prev.filter((e) => !urls.has(e.url))];
      }),
    );
  };
  useEffect(refreshList, [sessionId, connected]);

  const open = (url: string, line?: number) => {
    setCurrent(url);
    setTargetLine(line);
    setFindLine(undefined);
    setPretty(false);
    const cached = textCache.get(`${sessionId}|${url}`);
    if (cached) return void setSource(cached);
    setLoading(true);
    setSource(null);
    void sourceText(sessionId, url).then((s) => {
      if (s) textCache.set(`${sessionId}|${url}`, s);
      setSource(s ?? { url, text: null, error: 'no reply from the page' });
      setLoading(false);
    });
  };

  // "Go to source" from a location link.
  useEffect(() => {
    // Another session's request: this panel remounts per session, so without
    // the check it would open that session's file as soon as it appears.
    if (!target || target.sessionId !== sessionId) return;
    const url = String(target.url ?? '').split('#')[0]!;
    if (!entries.some((e) => e.url === url)) setEntries((list) => [...list, { url, kind: guessKind(url), inline: false, label: fileName(url) }]);
    open(url, target.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.nonce]);

  const lang: CodeLanguage = useMemo(() => {
    const e = entries.find((x) => x.url === current);
    const mime = e?.kind === 'script' ? 'text/javascript' : e?.kind === 'stylesheet' ? 'text/css' : e?.kind === 'document' ? 'text/html' : undefined;
    return detectLanguage(mime, source?.text ?? '');
  }, [entries, current, source]);
  const code = useMemo(() => (source?.text && pretty && canFormat(lang) ? formatCode(source.text, lang) : source?.text ?? ''), [source, pretty, lang]);

  // Deferred: on a large file a scan plus a full gutter redraw per keystroke
  // makes typing stutter, and the result is only ever one frame behind.
  const findQuery = useDeferredValue(find);
  const matches = useMemo(() => {
    const q = findQuery.trim();
    if (!q) return [] as number[];
    const lower = q.toLowerCase();
    const out: number[] = [];
    code.split('\n').forEach((l, i) => {
      if (l.toLowerCase().includes(lower)) out.push(i + 1);
    });
    return out;
  }, [code, findQuery]);
  const matchLines = useMemo(() => new Set(matches), [matches]);
  const [findNonce, setFindNonce] = useState(0);
  const jumpMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (findIdx + dir + matches.length) % matches.length;
    setFindIdx(next);
    setFindLine(matches[next]);
    setFindNonce((n) => n + 1);
  };

  // Like Chrome: typing lands on the first match straight away, so the counter
  // and the highlight agree from the first keystroke instead of reading
  // "1 of 12" with nothing marked.
  useEffect(() => {
    if (!matches.length) {
      setFindIdx(-1);
      setFindLine(undefined);
      return;
    }
    setFindIdx(0);
    setFindLine(matches[0]);
    setFindNonce((n) => n + 1);
  }, [matches]);

  const pageHost = useMemo(() => {
    const doc = entries.find((e) => e.kind === 'document' && !e.inline);
    return doc ? hostOf(doc.url, doc.url) : hostOf(session?.url ?? '');
  }, [entries, session]);

  return (
    /*
     * The line between the file tree and the code is draggable, and the tree
     * is the pane that keeps its width: a wider window should give the room
     * to the code, which is the thing being read. `side` is therefore the
     * tree even though it is drawn on the left.
     */
    <SplitView
      sideOn="start"
      initialSide={230}
      minSide={110}
      minMain={240}
      storageKey="bxconsole.sources.nav"
      side={
        navOpen ? (
          <div className="sources-nav">
          <Toolbar>
            <ToolbarInput placeholder="Filter files" value={filter} onChange={setFilter} />
            <ToolbarButton title={connected ? 'Reload the files from the page' : 'The page is gone; there is nothing to reload'} disabled={!connected} onClick={refreshList}>
              ⟳
            </ToolbarButton>
          </Toolbar>
            {entries.length > 0 ? (
              <SourceTree entries={entries} filter={filter} current={current} pageHost={pageHost} onOpen={(url) => open(url)} />
            ) : (
              <div className="dom-empty">
                {connected ? 'No sources reported yet.' : 'Nothing was kept from this run: its files were never opened while it was live.'}
              </div>
            )}
          </div>
        ) : null
      }
      main={
        <div className="sources-editor">
        <Toolbar wrap>
          <ToolbarButton title={navOpen ? 'Hide navigator' : 'Show navigator'} onClick={() => setNavOpen((o) => !o)}>
            {navOpen ? '◧' : '◨'}
          </ToolbarButton>
          <ToolbarDivider />
          <span className="sources-path mono" title={current ?? ''}>
            {current ?? 'Select a file'}
          </span>
          {source?.text && (
            <span className="sources-controls">
              <input
                ref={findRef}
                className="toolbar-input sources-find"
                data-find=""
                placeholder="Find"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jumpMatch(e.shiftKey ? -1 : 1);
                  if (e.key === 'Escape') setFind('');
                }}
              />
              <span className="detail-note">{find ? `${matches.length ? findIdx + 1 : 0} of ${matches.length}` : ''}</span>
              <ToolbarDivider />
              {canFormat(lang) && (
                <button className={`detail-format${pretty ? ' on' : ''}`} title="Pretty print (line numbers then refer to the formatted text)" onClick={() => setPretty((p) => !p)}>
                  {'{ }'}
                </button>
              )}
              <label className="toolbar-check">
                <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
              </label>
            </span>
          )}
        </Toolbar>
        {loading && <div className="dom-empty">Loading…</div>}
        {!loading && source && source.text === null && <div className="dom-empty">Could not load: {source.error}</div>}
        {!loading && source?.text != null && (
          <CodeView
            code={code}
            language={lang}
            wrap={wrap}
            activeLine={findLine ?? (pretty ? undefined : targetLine)}
            activeNonce={(target?.nonce ?? 0) + findNonce}
            matches={matchLines}
          />
        )}
        {!loading && !source && <div className="dom-empty">Pick a file on the left, or click a location link in the Console or Network tab.</div>}
          {source?.truncated && <div className="detail-note sources-truncated">truncated to 2 MB</div>}
        </div>
      }
    />
  );
}
function guessKind(url: string): SourceEntry['kind'] {
  const ext = (String(url ?? '').split('?')[0]!.split('.').pop() ?? '').toLowerCase();
  if (['js', 'mjs', 'cjs', 'ts'].includes(ext)) return 'script';
  if (ext === 'css') return 'stylesheet';
  return 'document';
}
