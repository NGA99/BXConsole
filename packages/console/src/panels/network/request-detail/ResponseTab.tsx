/** The body as it arrived: syntax-highlighted, optionally pretty-printed. */
import { useState } from 'react';
import type { NetworkEntry } from '../../../state/session-data';
import { formatBytes } from '../classify';
import { CodeView, canFormat, detectLanguage, formatCode } from '../../../devtools-ui/CodeView';
import { Empty } from './bits';
import { useBody, missingBody, FromPageNote } from './use-body';

export function ResponseTab({ entry, sessionId }: { entry: NetworkEntry; sessionId: string }) {
  const [pretty, setPretty] = useState(false);
  const [wrap, setWrap] = useState(false);
  const loaded = useBody(entry, sessionId);
  const missing = missingBody(entry, loaded);
  if (missing) return missing;
  const body = loaded.body!;
  if (loaded.base64) {
    return (
      <Empty>
        Binary response ({formatBytes(Math.round((body.length * 3) / 4))}); see Preview. <FromPageNote loaded={loaded} />
      </Empty>
    );
  }
  const lang = detectLanguage(loaded.mimeType, body);
  const code = pretty && canFormat(lang) ? formatCode(body, lang) : body;
  return (
    <div className="detail-code">
      <div className="detail-bar">
        {canFormat(lang) && (
          <button className={`detail-format${pretty ? ' on' : ''}`} title="Pretty print" onClick={() => setPretty((p) => !p)}>
            {'{ }'}
          </button>
        )}
        <label className="toolbar-check" title="Wrap long lines">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <span className="detail-note">
          {lang} · {formatBytes(body.length)}
          {entry.response?.bodyTruncated && !loaded.fromPage ? ' · truncated by agent' : ''}
        </span>
        <FromPageNote loaded={loaded} />
      </div>
      <CodeView code={code} language={lang} wrap={wrap} />
    </div>
  );
}
