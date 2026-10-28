/**
 * The agent's own source, read-only.
 *
 * What the relay serves at `/agent.js` is minified, and pretty-printing that
 * gives back the shape without the names — which is most of what makes source
 * worth reading. So this fetches the unminified build the relay keeps beside
 * it, and falls back to the shipped bundle if that is not there (an older
 * build, or a relay serving a prebuilt directory).
 */
import { useEffect, useState } from 'react';
import { CodeView } from '../../devtools-ui/CodeView';
import { copyText } from '../network/copy';

interface Source {
  text: string;
  url: string;
  minified: boolean;
}

export function AgentSource({ origin }: { origin: string }) {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [find, setFind] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      for (const [url, minified] of [
        [`${origin}/agent.source.js`, false],
        [`${origin}/agent.js`, true],
      ] as const) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const text = await res.text();
          if (!cancelled) setSource({ text, url, minified });
          return;
        } catch {
          /* try the next one */
        }
      }
      if (!cancelled) setError('The relay did not serve the agent source.');
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [origin]);

  const matches = (() => {
    const q = find.trim().toLowerCase();
    if (!q || !source) return new Set<number>();
    const out = new Set<number>();
    source.text.split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(q)) out.add(i + 1);
    });
    return out;
  })();

  if (error) return <div className="install-hint">{error}</div>;
  if (!source) return <div className="install-hint">Loading the agent source…</div>;

  return (
    <div className="install-source">
      <div className="install-snippet-head">
        <span className="mono">{source.url.replace(origin, '')}</span>
        <span className="install-source-meta">
          {Math.round(source.text.length / 1024)} kB · {source.text.split('\n').length.toLocaleString()} lines
          {source.minified ? ' · minified build' : ''}
        </span>
        <div style={{ flex: 1 }} />
        <input
          className="field toolbar-input"
          placeholder="Find"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          spellCheck={false}
        />
        <label className="toolbar-check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <button
          className="detail-link"
          onClick={() => {
            void copyText(source.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div className="install-source-body">
        <CodeView code={source.text} language="javascript" wrap={wrap} matches={matches} />
      </div>
      <div className="install-hint">
        Read-only. To change what the agent does, use the options above — they are its real configuration surface. Editing this file would mean
        the relay serving code someone could change from anywhere that can reach it, which is a bigger door than this tool should have while it
        has no login.
      </div>
    </div>
  );
}
