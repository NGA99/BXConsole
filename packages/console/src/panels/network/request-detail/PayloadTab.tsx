/** What the page sent: the query string, a form, or the request body. */
import { useState } from 'react';
import type { NetworkEntry } from '../../../state/session-data';
import { headerOf } from '../field-guard';
import { toSerialized, tryParseJson } from '../json-to-serialized';
import { ObjectTree } from '../../console/ObjectTree';
import { Section, KV } from './bits';

export function PayloadTab({ entry, sessionId }: { entry: NetworkEntry; sessionId: string }) {
  const [source, setSource] = useState(false);
  const [decoded, setDecoded] = useState(true);
  const url = new URL(entry.request.url, 'http://x');
  const params = decoded
    ? Array.from(url.searchParams.entries())
    : url.search
        .slice(1)
        .split('&')
        .filter(Boolean)
        .map((kv) => {
          const i = kv.indexOf('=');
          return [i < 0 ? kv : kv.slice(0, i), i < 0 ? '' : kv.slice(i + 1)] as [string, string];
        });
  const body = entry.request.body;
  const ctype = headerOf(entry.request.headers, 'content-type');
  const json = ctype.includes('json') || !ctype ? tryParseJson(body) : undefined;
  const form = ctype.includes('x-www-form-urlencoded') && body ? Array.from(new URLSearchParams(body).entries()) : null;

  return (
    <div className="detail-sections">
      {params.length > 0 && (
        <Section
          title={`Query String Parameters (${params.length})`}
          action={<button className="detail-link" onClick={() => setDecoded((d) => !d)}>{decoded ? 'view URL-encoded' : 'view decoded'}</button>}
        >
          {params.map(([k, v], i) => (
            <KV key={i} name={k} value={v} />
          ))}
        </Section>
      )}
      {form && (
        <Section title="Form Data">
          {form.map(([k, v], i) => (
            <KV key={i} name={k} value={v} />
          ))}
        </Section>
      )}
      {body && !form && (
        <Section
          title="Request Payload"
          action={
            json !== undefined ? (
              <button className="detail-link" onClick={() => setSource((s) => !s)}>
                {source ? 'view parsed' : 'view source'}
              </button>
            ) : undefined
          }
        >
          {json !== undefined && !source ? (
            <div className="mono">
              <ObjectTree value={toSerialized(json)} sessionId={sessionId} expanded />
            </div>
          ) : (
            <pre className="detail-pre">{body}{entry.request.bodyTruncated ? '\n… (truncated)' : ''}</pre>
          )}
        </Section>
      )}
    </div>
  );
}
