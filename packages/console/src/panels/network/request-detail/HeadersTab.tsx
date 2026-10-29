/** General, then what the page could read of the response's and request's headers. */
import { useState } from 'react';
import type { NetworkEntry } from '../../../state/session-data';
import { headerCount, headerPairs } from '../field-guard';
import { streamsFrames, formatBytes } from '../classify';
import { fullTimestamp } from '../../../devtools-ui/time';
import { Section, KV } from './bits';

function sortedEntries(h: Record<string, string>): Array<[string, string]> {
  return headerPairs(h).sort(([a], [b]) => a.localeCompare(b));
}

export function HeadersTab({ entry }: { entry: NetworkEntry }) {
  const status = entry.failed ? undefined : entry.response?.status ?? entry.resource?.responseStatus;
  const [rawResponse, setRawResponse] = useState(false);
  const [rawRequest, setRawRequest] = useState(false);
  const raw = (h: Record<string, string>) => headerPairs(h).map(([k, v]) => `${k}: ${v}`).join('\n');
  return (
    <div className="detail-sections">
      <Section title="General">
        <KV name="Request URL" value={entry.request.url} />
        <KV name="Request Method" value={entry.request.method} />
        {status !== undefined && (
          <KV
            name="Status Code"
            value={
              <>
                <span className={`status-dot ${status >= 400 ? 'error' : status >= 300 ? 'redirect' : 'ok'}`} />
                {status} {entry.response?.statusText ?? ''}
              </>
            }
          />
        )}
        {entry.failed && <KV name="Error" value={entry.failed.error} />}
        {entry.resource && <KV name="Initiator Type" value={entry.resource.initiatorType} />}
        {/* When the request was made, on the wall clock. Everything else about timing is a duration. */}
        <KV name="Request Time" value={fullTimestamp(entry.request.ts)} />
      </Section>
      {entry.response && (
        <Section
          title={`Response Headers (${headerCount(entry.response.headers)})`}
          /* No link when there is nothing to see either way: a header count
             of zero was still offering to show you the source of it, which is
             a request line and a blank space. */
          action={
            headerCount(entry.response.headers) > 0 ? (
              <button className="detail-link" onClick={() => setRawResponse((r) => !r)}>{rawResponse ? 'view parsed' : 'view source'}</button>
            ) : undefined
          }
        >
          {headerCount(entry.response.headers) === 0 ? (
            /* Two ways to have none, and the reason is the useful part. The
               first version of this said "no-cors" for both, which told an
               operator looking at a WebSocket about a kind of fetch they had
               not made. */
            <div className="detail-note">
              {streamsFrames(entry) ? (
                <>None. A WebSocket&apos;s upgrade is carried out by the browser, and its headers never reach the page — the messages are on the Messages tab.</>
              ) : (
                <>
                  None the page could read. A response fetched with <code>mode: &quot;no-cors&quot;</code> is opaque: its headers never reach the script this
                  console records from, so there is nothing here to have missed.
                </>
              )}
            </div>
          ) : rawResponse ? (
            <pre className="detail-pre">{`HTTP/1.1 ${entry.response.status} ${entry.response.statusText}\n${raw(entry.response.headers)}`}</pre>
          ) : (
            sortedEntries(entry.response.headers).map(([k, v]) => <KV key={k} name={k} value={v} />)
          )}
        </Section>
      )}
      {!entry.resource && (
        <Section
          title={`Request Headers (${headerCount(entry.request.headers)})`}
          note="Provisional headers are shown. Browser-added headers (cookie, user-agent…) are not visible from page scripts."
          action={
            headerCount(entry.request.headers) > 0 ? (
              <button className="detail-link" onClick={() => setRawRequest((r) => !r)}>{rawRequest ? 'view parsed' : 'view source'}</button>
            ) : undefined
          }
        >
          {headerCount(entry.request.headers) === 0 ? (
            <div className="detail-note">The page set none of its own.</div>
          ) : rawRequest ? (
            <pre className="detail-pre">{`${entry.request.method} ${entry.request.url} HTTP/1.1\n${raw(entry.request.headers)}`}</pre>
          ) : (
            sortedEntries(entry.request.headers).map(([k, v]) => <KV key={k} name={k} value={v} />)
          )}
        </Section>
      )}
      {entry.resource && (
        <Section title="Resource Timing">
          <KV name="Transfer Size" value={formatBytes(entry.resource.transferSize)} />
          <KV name="Encoded Body Size" value={formatBytes(entry.resource.encodedBodySize)} />
          <KV name="Decoded Body Size" value={formatBytes(entry.resource.decodedBodySize)} />
          <div className="detail-note">Headers and bodies are not available for resources observed via PerformanceObserver.</div>
        </Section>
      )}
    </div>
  );
}
