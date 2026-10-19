/**
 * Webhook tab: what a page managed to send us, and what that says about why
 * it is not showing up.
 *
 * Laid out like a request bin, because that is what it is — an inbox on the
 * left, what arrived on the right. The difference from a general-purpose bin
 * is that this one has an opinion: the probes are fixed, one per way into the
 * relay, and the landing pane reads them as a verdict. See the protocol's
 * ping.ts for why each probe exists, and diagnose.ts for how they are read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROBES, PROBE_DIRECTIVE, type Probe, type ProbeArrival } from '@bxconsole/protocol';
import { newPingToken, pingTokenLive, subscribePings } from '../../transport/client';
import { copyText } from '../network/copy';
import { clockTimeShort, fullTimestamp } from '../../devtools-ui/time';
import { agentVerdict, readFraming, readMatrix, snippetFor, tagFor, urlFor, type Arrived } from './diagnose';
import { useSessionList } from '../../state/sessions';
import './WebhookPanel.css';

const PROBE_LABEL: Record<Probe, string> = {
  img: '<img>',
  style: '<link rel=stylesheet>',
  script: '<script>',
  fetch: 'fetch()',
  websocket: 'WebSocket',
};

/** The token survives a reload, so a snippet already pasted into a page keeps reporting somewhere we are listening. */
const TOKEN_KEY = 'bxconsole.ping.token';

export function WebhookPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** the kept token has lapsed: nothing is being recorded for it any more */
  const [expired, setExpired] = useState(false);
  const [arrivals, setArrivals] = useState<ProbeArrival[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const startedAt = useRef(Date.now());

  const copy = async (id: string, text: string) => {
    await copyText(text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
  };

  const begin = useCallback((fresh: boolean) => {
    setArrivals([]);
    setSelected(null);
    setFailed(false);
    let kept: string | null = null;
    try {
      kept = fresh ? null : localStorage.getItem(TOKEN_KEY);
    } catch {
      kept = null;
    }
    setToken(null);
    setExpired(false);
    /*
     * A kept token is only worth reusing if the relay still honours it. It
     * lapses after a day, and a lapsed one fails silently — the probe gets a
     * 200, so the page looks fine and nothing ever shows up here. Ask first,
     * and say so rather than listening to a token nobody is recording.
     */
    void (async () => {
      if (kept && (await pingTokenLive(kept))) return setToken(kept);
      if (kept) return setExpired(true);
      const issued = await newPingToken();
      if (!issued) return setFailed(true);
      try {
        localStorage.setItem(TOKEN_KEY, issued.token);
      } catch {
        /* a token that cannot be remembered still works for this visit */
      }
      setToken(issued.token);
    })();
  }, []);

  useEffect(() => begin(false), [begin]);

  useEffect(() => {
    if (!token) return;
    // The relay replays what already landed, so the same arrival can come twice.
    return subscribePings(token, (a) => setArrivals((prev) => (prev.some((p) => p.id === a.id) ? prev : [...prev, a])));
  }, [token]);

  const origin = window.location.origin;
  const arrived: Arrived = {};
  for (const a of arrivals) arrived[a.probe] = true;
  const page = arrivals.find((a) => a.pageUrl)?.pageUrl ?? arrivals.find((a) => a.referer)?.referer;
  const sessions = useSessionList();
  // Only the script probe can tell us this, and only once it ran.
  const reported = arrivals.find((a) => a.framing)?.framing;
  const framing = reported ? readFraming(reported.xFrameOptions, reported.frameAncestors, page) : null;
  const base = readMatrix(arrived);
  // Everything through is not the end of the story: the page still has to run
  // the agent and say hello, and that is the next thing someone would ask.
  const verdict = base?.tone === 'ok' ? agentVerdict(sessions.map((x) => x.url), page) : base;

  /** The whole run as one block of text, for handing to whoever owns the CSP or the firewall. */
  const asReport = () =>
    JSON.stringify(
      {
        relay: origin,
        token,
        verdict: verdict ? { headline: verdict.headline, detail: verdict.detail } : null,
        page: page ?? null,
        probes: PROBES.map((probe) => {
          const hit = arrivals.find((a) => a.probe === probe);
          return {
            probe,
            directive: PROBE_DIRECTIVE[probe],
            url: token ? urlFor(origin, probe, token) : null,
            arrived: hit ? new Date(hit.ts).toISOString() : null,
          };
        }),
        requests: arrivals.map((a) => ({
          probe: a.probe,
          at: new Date(a.ts).toISOString(),
          method: a.method,
          path: a.path,
          ip: a.ip,
          headers: a.headers,
          withheld: a.withheld,
        })),
      },
      null,
      2,
    );

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const newestFirst = [...arrivals].reverse();
    if (!q) return newestFirst;
    return newestFirst.filter((a) => `${a.probe} ${a.path ?? ''} ${a.ip ?? ''} ${a.referer ?? ''}`.toLowerCase().includes(q));
  }, [arrivals, filter]);
  const open = arrivals.find((a) => a.id === selected) ?? null;

  if (failed) return <div className="dom-empty">The relay did not hand out a token. Reload the console and try again.</div>;
  if (expired)
    return (
      <div className="dom-empty">
        <p>This token has expired, so nothing sent to its URL is being recorded any more.</p>
        <p>
          <button className="detail-link" onClick={() => begin(true)}>
            Make a new token
          </button>
        </p>
      </div>
    );

  return (
    <div className="diag">
      <aside className="diag-inbox">
        <div className="diag-inbox-head">
          <span>Inbox ({arrivals.length})</span>
          <span className="diag-inbox-actions">
            <button className="detail-link" disabled={arrivals.length === 0} onClick={() => void copy('report', asReport())}>
              {copied === 'report' ? 'copied' : 'copy all'}
            </button>
            <button className="detail-link" onClick={() => begin(true)}>
              new token
            </button>
          </span>
        </div>
        <input className="toolbar-input diag-search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {arrivals.length === 0 && <div className="diag-empty">Waiting for the first request</div>}
        {arrivals.length > 0 && shown.length === 0 && <div className="diag-empty">Nothing matches.</div>}
        {shown.map((a) => (
          <button
            key={a.id}
            className={`diag-req${a.id === selected ? ' selected' : ''}`}
            onClick={() => setSelected(a.id === selected ? null : a.id)}
          >
            <div className="diag-req-top">
              <span className="diag-method">{a.method ?? 'GET'}</span>
              <span className="diag-req-probe">{a.probe}</span>
            </div>
            <div className="diag-req-sub">
              {clockTimeShort(a.ts)} · {a.ip ?? 'unknown'}
            </div>
          </button>
        ))}
      </aside>

      <section className="diag-detail">
        {open ? (
          <RequestDetail
            arrival={open}
            onBack={() => setSelected(null)}
            onCopy={() => void copy('one', JSON.stringify(open, null, 2))}
            copied={copied === 'one'}
          />
        ) : (
          <>
            {verdict && (
              <div className={`diag-verdict tone-${verdict.tone}`}>
                <strong>{verdict.headline}</strong>
                <p>{verdict.detail}</p>
              </div>
            )}

            <div className="diag-h-row">
              <h3 className="diag-h">Ways in</h3>
              <span className="diag-note">
                One per kind of subresource, each governed by its own CSP directive.
                {token && <span className="diag-token"> token {token}</span>}
              </span>
            </div>
            <table className="diag-matrix">
              <colgroup>
                <col />
                <col className="c-state" />
                <col className="c-at" />
                <col className="c-directive" />
                <col className="c-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th>Way in</th>
                  <th>State</th>
                  <th>Arrived</th>
                  <th>CSP directive</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {PROBES.map((probe) => {
                  const hit = arrivals.find((a) => a.probe === probe);
                  const url = token ? urlFor(origin, probe, token) : '';
                  const tag = token ? tagFor(origin, probe, token) : null;
                  return (
                    <tr key={probe} className={hit ? 'arrived' : 'pending'}>
                      <td className="mono">{PROBE_LABEL[probe]}</td>
                      <td>{hit ? 'arrived' : 'waiting'}</td>
                      <td className="mono" title={hit ? fullTimestamp(hit.ts) : undefined}>
                        {hit ? clockTimeShort(hit.ts) : '—'}
                      </td>
                      <td className="mono">{PROBE_DIRECTIVE[probe]}</td>
                      {/* The URL itself is not shown: five of them in full is a wall
                          nobody reads, and the point of one is to be copied. */}
                      <td className="diag-row-actions">
                        <button className="detail-link" disabled={!token} title={url} onClick={() => void copy(`u-${probe}`, url)}>
                          {copied === `u-${probe}` ? 'copied' : 'url'}
                        </button>
                        {tag && (
                          <button className="detail-link" title={tag} onClick={() => void copy(`t-${probe}`, tag)}>
                            {copied === `t-${probe}` ? 'copied' : 'tag'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="diag-h-row">
              <h3 className="diag-h">Paste into the page</h3>
              <button className="detail-link" disabled={!token} onClick={() => token && void copy('all', snippetFor(origin, token))}>
                {copied === 'all' ? 'copied' : 'copy'}
              </button>
              <span className="diag-note">
                Plain HTML, so the first two arrive even when scripts are blocked — which is the thing worth knowing.
              </span>
            </div>
            <pre className="diag-snippet mono">{token ? snippetFor(origin, token) : 'Getting a token…'}</pre>

            {framing && (
              <div className="diag-framing">
                <strong>{framing.can ? 'This page can be put in a frame' : 'This page cannot be put in a frame'}</strong>
                <p>
                  {framing.why}
                  {framing.can
                    ? framing.silent
                      ? ' — so the agent could host it in an iframe and survive its navigations.'
                      : ' — so the agent could host it in an iframe and survive its navigations.'
                    : ' — hosting it in an iframe would show nothing at all, so that option is not available here.'}
                </p>
              </div>
            )}

            {origin.startsWith('http://') && (
              <p className="diag-warn">
                If the page is served over <code>https</code>, the browser blocks this address outright (mixed content) and nothing will arrive.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function RequestDetail({
  arrival,
  onBack,
  onCopy,
  copied,
}: {
  arrival: ProbeArrival;
  onBack: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const headers = Object.entries(arrival.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <div className="diag-h-row">
        <h3 className="diag-h">Request details and headers</h3>
        <button className="detail-link" onClick={onBack}>
          back to probes
        </button>
        <button className="detail-link" onClick={onCopy}>
          {copied ? 'copied' : 'copy this request'}
        </button>
      </div>
      <dl className="diag-facts">
        <div className="diag-facts-row">
          <dt>Probe</dt>
          <dd className="mono">{arrival.probe}</dd>
        </div>
        <div className="diag-facts-row">
          <dt>Request</dt>
          <dd className="mono">{`${arrival.method ?? 'GET'} ${arrival.path ?? ''}`}</dd>
        </div>
        <div className="diag-facts-row">
          <dt>Date</dt>
          <dd className="mono">{fullTimestamp(arrival.ts)}</dd>
        </div>
        <div className="diag-facts-row">
          <dt>Address</dt>
          <dd className="mono">{arrival.ip ?? '—'}</dd>
        </div>
        <div className="diag-facts-row">
          <dt>Page</dt>
          <dd className="mono">{arrival.pageUrl ?? arrival.referer ?? '—'}</dd>
        </div>
      </dl>

      <h3 className="diag-h">Headers</h3>
      <dl className="diag-facts">
        {headers.map(([name, value]) => (
          <div className="diag-facts-row" key={name}>
            <dt>{name}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
        {(arrival.withheld ?? []).map((name) => (
          <div className="diag-facts-row" key={name}>
            <dt>{name}</dt>
            <dd className="diag-withheld">not stored</dd>
          </div>
        ))}
      </dl>
      {(arrival.withheld?.length ?? 0) > 0 && (
        <p className="diag-note">
          This relay has no login, so anything kept here is readable by anyone who can reach it. Credentials are dropped on arrival, and they
          answer nothing about which way in is blocked.
        </p>
      )}
    </>
  );
}
