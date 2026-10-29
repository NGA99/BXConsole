/** The body rendered: an image, a JSON tree, a sandboxed page, or plain text. */
import type { ReactNode } from 'react';
import type { NetworkEntry } from '../../../state/session-data';
import { formatBytes } from '../classify';
import { toSerialized, tryParseJson } from '../json-to-serialized';
import { ObjectTree } from '../../console/ObjectTree';
import { Empty } from './bits';
import { useBody, missingBody, FromPageNote } from './use-body';

export function PreviewTab({ entry, sessionId }: { entry: NetworkEntry; sessionId: string }) {
  const loaded = useBody(entry, sessionId);
  const missing = missingBody(entry, loaded);
  if (missing) return missing;
  const body = loaded.body!;
  const mime = loaded.mimeType ?? '';
  let content: ReactNode;
  if (loaded.base64) {
    content = mime.startsWith('image/') ? (
      <div className="detail-image"><img src={`data:${mime};base64,${body}`} alt="" /></div>
    ) : (
      <Empty>Binary response ({formatBytes(Math.round((body.length * 3) / 4))}).</Empty>
    );
  } else {
    const json = mime.includes('json') || !mime ? tryParseJson(body) : undefined;
    if (json !== undefined) {
      content = (
        <div className="detail-sections mono">
          <ObjectTree value={toSerialized(json)} sessionId={sessionId} expanded />
        </div>
      );
    } else if (mime.includes('html')) content = <iframe className="detail-frame" sandbox="" srcDoc={body} title="preview" />;
    else content = <pre className="detail-pre">{body}</pre>;
  }
  return (
    <div className="detail-code">
      {loaded.fromPage && (
        <div className="detail-bar">
          <FromPageNote loaded={loaded} />
        </div>
      )}
      {content}
    </div>
  );
}
