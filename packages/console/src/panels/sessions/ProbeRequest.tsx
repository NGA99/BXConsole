/**
 * One probe's arrival, spelled out: what was requested, from where, and every
 * header the relay kept.
 *
 * It was called `RequestDetail`, inside WebhookPanel.tsx — the same name the
 * Network panel's drawer has, for a different thing. A probe arrival is not a
 * request the page made; it is a request made *to* the relay to find out which
 * way in is open.
 */
import type { ProbeArrival } from '@bxconsole/protocol';
import { fullTimestamp } from '../../devtools-ui/time';
import './WebhookPanel.css';

export function ProbeRequest({
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
