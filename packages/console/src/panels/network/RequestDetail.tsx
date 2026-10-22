/**
 * The drawer that opens when a row is selected:
 * Headers · Payload · Preview · Response · Timing
 */
import { useEffect, useReducer, useState, type ReactNode } from 'react';
import type { SourceText } from '@bxconsole/protocol';
import type { NetworkEntry, WsFrame } from '../../state/session-data';
import { sourceText } from '../../transport/client';
import { held, load } from './stored-bodies';
import { bodySource } from './body-source';
import { TabBar } from '../../devtools-ui/TabBar';
import { ObjectTree } from '../console/ObjectTree';
import { nameOf, formatMs, formatBytes, streamsFrames } from './classify';
import { headerCount, headerOf, headerPairs } from './field-guard';
import { timelineOf, shownTiming } from './timing';
import { toSerialized, tryParseJson } from './json-to-serialized';
import { PHASE_COLORS } from './Waterfall';
import { StackTrace } from '../console/StackTrace';
import { CodeView, canFormat, detectLanguage, formatCode } from '../../devtools-ui/CodeView';
import { clockTime, fullTimestamp } from '../../devtools-ui/time';

type TabId = 'headers' | 'payload' | 'preview' | 'response' | 'initiator' | 'timing' | 'messages';

/**
 * Bodies the agent did not capture (resources seen only through resource timing,
 * fetches made before the hook, truncated bodies) are fetched from inside the page
 * on demand, cache-first, the same way the Sources tab reads files. Not the original
 * response bytes, so the UI says so.
 */
const lazyBodies = new Map<string, SourceText>();
/** Re-reads in progress, so selecting a row twice does not ask the page twice. */
const asking = new Set<string>();

interface LoadedBody {
  body: string | null;
  mimeType: string | undefined;
  base64: boolean;
  fromPage: boolean;
  loading: boolean;
  error?: string;
  /** the body is missing and re-reading it would mean issuing a different request than this row */
  notReReadable?: boolean;
}

/**
 * The body for the selected row, from wherever it can be had.
 *
 * Everything is read from the module caches during render rather than copied
 * into state. Copying was the bug: `useState` runs its initialiser once per
 * component, this drawer is reused as the selection moves from row to row,
 * and so a second request showed the first one's body — or, because the
 * effect saw a body already in hand, never loaded at all.
 */
function useBody(entry: NetworkEntry, sessionId: string): LoadedBody {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const res = entry.response;
  const source = bodySource(entry);
  const ref = source.from === 'store' ? source.sha : undefined;
  // Keyed by the request, not the URL: two rows on one endpoint, or the same
  // URL after a reload, are different responses and must not share a body.
  const key = `${sessionId}|${entry.requestId}`;

  useEffect(() => {
    if (!ref || held(ref)) return;
    let live = true;
    void load(sessionId, ref, res?.mimeType).then(() => {
      if (live) rerender();
    });
    return () => {
      live = false;
    };
  }, [ref, sessionId, res?.mimeType]);

  const askRelay = source.from === 'ask';
  useEffect(() => {
    if (!askRelay || lazyBodies.has(key) || asking.has(key)) return;
    let live = true;
    asking.add(key);
    rerender();
    void sourceText(sessionId, entry.request.url).then((r) => {
      lazyBodies.set(key, r ?? { url: entry.request.url, text: null, error: 'no reply from the page' });
      asking.delete(key);
      if (live) rerender();
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, askRelay]);

  const blank = { body: null, mimeType: res?.mimeType, base64: false, fromPage: false, loading: false } satisfies LoadedBody;

  switch (source.from) {
    case 'event':
      return { body: res!.body!, mimeType: res!.mimeType, base64: res!.bodyEncoding === 'base64', fromPage: false, loading: false };
    case 'store': {
      const stored = held(source.sha);
      if (!stored) return { ...blank, loading: true };
      if ('error' in stored) return { ...blank, error: stored.error };
      return { body: stored.text, mimeType: res?.mimeType, base64: stored.base64, fromPage: false, loading: false };
    }
    case 'ask': {
      const fetched = lazyBodies.get(key);
      if (!fetched) return { ...blank, loading: true };
      return {
        body: fetched.text,
        mimeType: fetched.mimeType ?? res?.mimeType,
        base64: fetched.encoding === 'base64',
        // A body the relay kept during the run is the real one; only a fresh
        // read from the page carries the "this may differ" caveat.
        fromPage: !fetched.fromStore,
        loading: false,
        ...(fetched.error ? { error: fetched.error } : {}),
      };
    }
    case 'nowhere':
      return {
        ...blank,
        ...(source.why === 'not-re-readable' ? { notReReadable: true } : {}),
      };
  }
}

/**
 * The body was not captured and the page that could still have produced it
 * has gone. Nothing here is retryable, so the drawer says so instead of
 * spinning on a request no window will ever answer.
 */
function RunEnded() {
  return (
    <Empty>
      This response body was not captured while the run was live. BXConsole re-reads a missing body from inside the page, and this run
      has ended — turn on <strong>Payloads</strong> in the Agent tab to capture bodies as they happen.
    </Empty>
  );
}

/**
 * The body was not captured and this row is not a GET, so there is nothing safe to re-read:
 * the agent would have to send a different request than the one being shown.
 */
function NotReReadable({ method }: { method: string }) {
  return (
    <Empty>
      This response body was not captured. BXConsole only re-reads a body by issuing a GET for the URL, which would not be
      this {method.toUpperCase()} request, so it was not attempted.
    </Empty>
  );
}

function FromPageNote({ loaded }: { loaded: LoadedBody }) {
  if (!loaded.fromPage) return null;
  return <span className="detail-note" title="The agent did not capture this body; it was re-fetched inside the page (cache-first), so it may differ from the original response">fetched from page</span>;
}

export function RequestDetail({ entry, sessionId, onClose }: { entry: NetworkEntry; sessionId: string; onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('headers');
  const hasPayload = Boolean(entry.request.body) || new URL(entry.request.url, 'http://x').search.length > 1;

  // Both kinds that stay open show the Frames tab and no response body.
  const isWs = streamsFrames(entry);
  const tabs = [
    { id: 'headers' as const, label: 'Headers' },
    { id: 'payload' as const, label: 'Payload', disabled: !hasPayload },
    ...(isWs ? [{ id: 'messages' as const, label: 'Messages' }] : []),
    { id: 'preview' as const, label: 'Preview', disabled: isWs },
    { id: 'response' as const, label: 'Response', disabled: isWs },
    { id: 'initiator' as const, label: 'Initiator' },
    { id: 'timing' as const, label: 'Timing' },
  ];

  /*
   * The selection follows the reader from row to row, which is what you want
   * for Headers or Timing and impossible for the rest: Messages is not there
   * at all on a row that does not stream, and Preview and Response are
   * disabled on a row that does. Left as it was, picking Messages on a socket
   * and then clicking a fetch row showed an empty "0 messages" table under a
   * tab strip with nothing selected in it.
   */
  const available = new Set(tabs.filter((t) => !('disabled' in t && t.disabled)).map((t) => t.id));
  const active: TabId = available.has(tab) ? tab : 'headers';

  return (
    <div className="request-detail">
      <TabBar
        tabs={tabs}
        active={active}
        onSelect={setTab}
        trailing={
          <button className="toolbar-button request-detail-close" title="Close" onClick={onClose}>
            ✕
          </button>
        }
      />
      <div className="request-detail-body">
        {active === 'headers' && <HeadersTab entry={entry} />}
        {active === 'payload' && <PayloadTab entry={entry} sessionId={sessionId} />}
        {active === 'preview' && <PreviewTab entry={entry} sessionId={sessionId} />}
        {active === 'response' && <ResponseTab entry={entry} sessionId={sessionId} />}
        {active === 'initiator' && <InitiatorTab entry={entry} />}
        {active === 'timing' && <TimingTab entry={entry} />}
        {active === 'messages' && <MessagesTab entry={entry} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Headers

function HeadersTab({ entry }: { entry: NetworkEntry }) {
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

// ------------------------------------------------------------------ Payload

function PayloadTab({ entry, sessionId }: { entry: NetworkEntry; sessionId: string }) {
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

// ------------------------------------------------------------------ Preview

function PreviewTab({ entry, sessionId }: { entry: NetworkEntry; sessionId: string }) {
  const loaded = useBody(entry, sessionId);
  if (loaded.loading) return <Empty>Loading from the page…</Empty>;
  if (loaded.body == null) {
    if (entry.failed) return <Empty>Request failed.</Empty>;
    if (loaded.error) return <Empty>Could not load the body: {loaded.error}</Empty>;
    if (loaded.notReReadable) return <NotReReadable method={entry.request.method} />;
    return <Empty>{entry.response || entry.resource ? 'This request has no response data available.' : 'Waiting for response…'}</Empty>;
  }
  const mime = loaded.mimeType ?? '';
  let content: ReactNode;
  if (loaded.base64) {
    content = mime.startsWith('image/') ? (
      <div className="detail-image"><img src={`data:${mime};base64,${loaded.body}`} alt="" /></div>
    ) : (
      <Empty>Binary response ({formatBytes(Math.round((loaded.body.length * 3) / 4))}).</Empty>
    );
  } else {
    const json = mime.includes('json') || !mime ? tryParseJson(loaded.body) : undefined;
    if (json !== undefined) {
      content = (
        <div className="detail-sections mono">
          <ObjectTree value={toSerialized(json)} sessionId={sessionId} expanded />
        </div>
      );
    } else if (mime.includes('html')) content = <iframe className="detail-frame" sandbox="" srcDoc={loaded.body} title="preview" />;
    else content = <pre className="detail-pre">{loaded.body}</pre>;
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

// ------------------------------------------------------------------ Response

function ResponseTab({ entry, sessionId }: { entry: NetworkEntry; sessionId: string }) {
  const [pretty, setPretty] = useState(false);
  const [wrap, setWrap] = useState(false);
  const loaded = useBody(entry, sessionId);
  if (loaded.loading) return <Empty>Loading from the page…</Empty>;
  if (loaded.body == null) {
    if (entry.failed) return <Empty>Request failed.</Empty>;
    if (loaded.error) return <Empty>Could not load the body: {loaded.error}</Empty>;
    if (loaded.notReReadable) return <NotReReadable method={entry.request.method} />;
    return <Empty>{entry.response || entry.resource ? 'This request has no response data available.' : 'Waiting for response…'}</Empty>;
  }
  if (loaded.base64) {
    return (
      <Empty>
        Binary response ({formatBytes(Math.round((loaded.body.length * 3) / 4))}); see Preview. <FromPageNote loaded={loaded} />
      </Empty>
    );
  }
  const lang = detectLanguage(loaded.mimeType, loaded.body);
  const code = pretty && canFormat(lang) ? formatCode(loaded.body, lang) : loaded.body;
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
          {lang} · {formatBytes(loaded.body.length)}
          {entry.response?.bodyTruncated && !loaded.fromPage ? ' · truncated by agent' : ''}
        </span>
        <FromPageNote loaded={loaded} />
      </div>
      <CodeView code={code} language={lang} wrap={wrap} />
    </div>
  );
}

// ------------------------------------------------------------------ Initiator

function InitiatorTab({ entry }: { entry: NetworkEntry }) {
  if (entry.request.stack) {
    return (
      <div className="detail-sections">
        <Section title="Request call stack">
          <div className="mono">
            <StackTrace stack={entry.request.stack} />
          </div>
        </Section>
      </div>
    );
  }
  return (
    <Empty>
      {entry.resource
        ? `Initiated by the ${entry.resource.initiatorType === 'navigation' ? 'navigation' : `HTML parser (${entry.resource.initiatorType})`}; no script stack for resources observed via PerformanceObserver.`
        : 'No initiator information.'}
    </Empty>
  );
}

// ------------------------------------------------------------------ Messages (WebSocket)

function MessagesTab({ entry }: { entry: NetworkEntry }) {
  const [filter, setFilter] = useState('');
  // Hold the frame itself: an index into the filtered list would point at a
  // different message once the filter changes or the 500-frame cap slides.
  const [selected, setSelected] = useState<WsFrame | null>(null);
  const frames = (entry.frames ?? []).filter((f) => !filter || f.data.includes(filter));
  const current = selected && frames.includes(selected) ? selected : undefined;
  return (
    <div className="ws-messages">
      <div className="detail-bar">
        <input className="toolbar-input" placeholder="Filter messages" value={filter} onChange={(e) => setFilter(e.target.value)} />
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

function prettyIfJson(text: string): string {
  const v = tryParseJson(text);
  return v === undefined ? text : JSON.stringify(v, null, 2);
}

// ------------------------------------------------------------------ Timing

function TimingTab({ entry }: { entry: NetworkEntry }) {
  const t = timelineOf(entry);
  if (t.end === null) return <Empty>Request is still pending.</Empty>;
  const shown = shownTiming({ ...t, end: t.end });
  // The bars are positions rather than printed figures, so they are drawn
  // from the unrounded span; `|| 1` keeps a request that took no measurable
  // time from dividing by zero.
  const span = t.end - t.start || 1;
  const pct = (ms: number) => `${(ms / span) * 100}%`;

  return (
    <div className="detail-sections">
      <Section title="Started">
        <KV name="Start Time" value={fullTimestamp(shown.start)} />
        <KV name="End Time" value={fullTimestamp(shown.end)} />
      </Section>
      <Section title={`Duration: ${formatMs(shown.total)}`}>
        <table className="timing-table">
          <tbody>
            {t.phases.map((p, i) => (
              <tr key={i}>
                <td className="timing-label">{p.label}</td>
                <td className="timing-bar-cell">
                  <div
                    className="timing-bar"
                    style={{ left: pct(p.start - t.start), width: pct(p.end - p.start), background: PHASE_COLORS[p.id] }}
                  />
                </td>
                <td className="timing-value">{formatMs(p.end - p.start)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="detail-note">
          {!entry.resource && 'Phases before "Waiting" (DNS, connect) are not observable from fetch/XHR.'}
          {entry.resource && !entry.resource.timing?.requestStart && 'Detailed phases need a Timing-Allow-Origin header from the server.'}
        </div>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ bits

function Section({ title, note, action, children }: { title: string; note?: string; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="detail-section">
      <div className="detail-section-title" onClick={() => setOpen((o) => !o)}>
        <span className={`otree-arrow${open ? ' open' : ''}`} />
        {title}
        {action && <span className="detail-section-action" onClick={(e) => e.stopPropagation()}>{action}</span>}
      </div>
      {open && (
        <div className="detail-section-body">
          {note && <div className="detail-note">{note}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

function KV({ name, value }: { name: string; value: ReactNode }) {
  return (
    <div className="detail-kv">
      <span className="detail-kv-name">{name}:</span>
      <span className="detail-kv-value">{value}</span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="detail-empty">{children}</div>;
}

function sortedEntries(h: Record<string, string>): Array<[string, string]> {
  return headerPairs(h).sort(([a], [b]) => a.localeCompare(b));
}

export { nameOf };
