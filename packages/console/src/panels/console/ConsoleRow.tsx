/**
 * One row of the Console, whatever it is a row of.
 *
 * `ConsoleRow` is the switch — a cleared console, a navigation, a failed
 * request, a command, its result, an uncaught error, a rejected promise, a
 * `console.*` call, or a group holding more of them — and `Line` is the shape
 * they all come out in: gutter icon · body · source link. Everything between
 * is one of those cases.
 *
 * They were the middle two hundred and fifty lines of ConsolePanel.tsx, which
 * is the panel's toolbar, sidebar, filtering, grouping and settings. Nothing
 * here knows about any of that; a row is given the row, the session and the
 * settings, and draws it.
 */
import { useState, type ReactNode } from 'react';
import type { SerializedValue } from '@bxconsole/protocol';
import type { ConsoleEntry } from '../../state/session-data';
import { clockTime as formatTime, fullTimestamp } from '../../devtools-ui/time';
import { SourceLink } from '../../devtools-ui/SourceLink';
import { safeHref } from '../../devtools-ui/safe-url';
import { ErrorIcon, WarnIcon, InfoIcon } from '../../devtools-ui/icons';
import { revealRequest } from '../../state/network-selection';
import { ObjectTree, Inline } from './ObjectTree';
import { StackTrace } from './StackTrace';
import { TableView } from './TableView';
import { applyFormat } from './format-spec';
import { listOf } from './format';
import { parseStack, shortLocation } from './stack';
import { severityOf, type Row } from './group-tree';
import type { Settings } from './settings';

export function ConsoleRow({ row, sessionId, settings }: { row: Row; sessionId: string; settings: Settings }) {
  const { entry } = row;

  if (row.children) return <GroupRow row={row} sessionId={sessionId} settings={settings} />;

  switch (entry.type) {
    case 'console.clear':
      return (
        <Line severity="info" entry={entry} settings={settings} className="console-cleared">
          Console was cleared
        </Line>
      );

    case 'page.navigated':
      return (
        <Line severity="info" entry={entry} settings={settings} className="console-navigated">
          Navigated to <a href={safeHref(entry.url)} target="_blank" rel="noreferrer">{entry.url}</a>
        </Line>
      );

    case 'network.error': {
      const sid = sessionId;
      return (
        <Line severity="error" entry={entry} settings={settings} repeat={row.repeat}>
          <span className="console-network-error">
            {entry.method}{' '}
            <a
              // The href is only there so the row reads and behaves like a
              // link; the click handler keeps the operator in the Network
              // panel. preventDefault is not the guard, though: a middle
              // click fires `auxclick`, not `click`, so it never runs and the
              // browser follows the href the page chose.
              href={safeHref(entry.url)}
              onClick={(e) => {
                e.preventDefault();
                revealRequest(sid, entry.requestId);
              }}
              title="Reveal in Network"
            >
              {entry.url}
            </a>{' '}
            {entry.status !== undefined ? `${entry.status} (${entry.statusText || 'error'})` : entry.error}
          </span>
        </Line>
      );
    }

    case 'eval.command':
      return (
        <Line severity="info" entry={entry} settings={settings} className="console-command" icon={<span className="console-chevron">›</span>}>
          <span className="console-command-text">{entry.expression}</span>
        </Line>
      );

    case 'eval.result': {
      const value = entry.exception ?? entry.result ?? { t: 'undefined' as const };
      return (
        <Line severity={severityOf(entry)} entry={entry} settings={settings} className="console-result" icon={<span className="console-chevron">‹</span>}>
          {entry.exception && <span className="console-uncaught">Uncaught </span>}
          <ObjectTree value={value} sessionId={sessionId} />
        </Line>
      );
    }

    case 'error.uncaught':
      return (
        <Line
          severity="error"
          entry={entry}
          settings={settings}
          repeat={row.repeat}
          location={shortLocation(entry.source ? { fn: '', url: entry.source, line: entry.line ?? 0, col: entry.col ?? 0, raw: '' } : undefined)}
          locationHref={entry.source}
          locationLine={entry.line}
        >
          <span className="console-uncaught">Uncaught </span>
          {/* The page's own message field: a string by type only. */}
          <span>{String(entry.message ?? '').replace(/^Uncaught\s+/, '')}</span>
          {entry.stack && <StackTrace stack={stripFirstLine(entry.stack)} />}
          {entry.cause && (
            <div className="console-cause">
              <span className="tok-meta">Caused by: </span>
              <ObjectTree value={entry.cause} sessionId={sessionId} />
            </div>
          )}
        </Line>
      );

    case 'error.unhandledrejection': {
      const top = entry.reason.t === 'error' ? parseStack(entry.reason.stack)[0] : undefined;
      return (
        <Line severity="error" entry={entry} settings={settings} repeat={row.repeat} location={shortLocation(top)} locationHref={top?.url} locationLine={top?.line}>
          <span className="console-uncaught">Uncaught (in promise) </span>
          <ObjectTree value={entry.reason} sessionId={sessionId} />
        </Line>
      );
    }

    case 'console.message':
      return <MessageRow row={row} sessionId={sessionId} settings={settings} />;
  }
}

function MessageRow({ row, sessionId, settings }: { row: Row; sessionId: string; settings: Settings }) {
  const entry = row.entry as Extract<ConsoleEntry, { type: 'console.message' }>;
  const frames = parseStack(entry.stack);
  const top = frames[0];
  const severity = severityOf(entry);

  const showStack = entry.level === 'trace' || entry.level === 'error' || entry.level === 'assert' || entry.level === 'warn';
  const [stackOpen, setStackOpen] = useState(entry.level === 'trace');

  let body: ReactNode;
  if (entry.level === 'table' && entry.args[0]) {
    body = (
      <>
        <TableView value={entry.args[0]} />
        <ObjectTree value={entry.args[0]} sessionId={sessionId} />
      </>
    );
  } else if (entry.level === 'dir' && entry.args[0]) {
    body = <ObjectTree value={entry.args[0]} sessionId={sessionId} expanded={false} />;
  } else {
    body = <Segments entry={entry} sessionId={sessionId} />;
  }

  return (
    <Line
      severity={severity}
      entry={entry}
      settings={settings}
      repeat={row.repeat}
      location={shortLocation(top)}
      locationHref={top?.url}
      locationLine={top?.line}
      className={`level-${entry.level}`}
    >
      {showStack && frames.length > 0 && (
        <span className={`otree-arrow${stackOpen ? ' open' : ''} console-stack-toggle`} onClick={() => setStackOpen((o) => !o)} />
      )}
      {body}
      {showStack && stackOpen && <StackTrace stack={entry.stack} />}
    </Line>
  );
}

/** The arguments of one console call, with %-format applied to the first. */
function Segments({ entry, sessionId }: { entry: Extract<ConsoleEntry, { type: 'console.message' }>; sessionId: string }) {
  const segments = applyFormat(entry.args);
  return (
    <>
      {segments.map((seg, i) => {
        const space = i > 0 && !(segments[i - 1]?.kind === 'text' && seg.kind === 'text') ? ' ' : '';
        if (seg.kind === 'text') {
          return (
            <span key={i} style={seg.style}>
              {space}
              {seg.text}
            </span>
          );
        }
        return (
          <span key={i} style={seg.style}>
            {space}
            <ObjectTree value={seg.value} sessionId={sessionId} topLevel />
          </span>
        );
      })}
    </>
  );
}

function GroupRow({ row, sessionId, settings }: { row: Row; sessionId: string; settings: Settings }) {
  const entry = row.entry as Extract<ConsoleEntry, { type: 'console.message' }>;
  const [open, setOpen] = useState(entry.level !== 'groupCollapsed');
  return (
    <div className="console-group">
      <Line severity="info" entry={entry} settings={settings} className="console-group-header" onClick={() => setOpen((o) => !o)}>
        <span className={`otree-arrow${open ? ' open' : ''}`} />
        <span className="console-group-title">
          {listOf<SerializedValue>(entry.args).map((a, i) => (
            <span key={i}>
              {i > 0 && ' '}
              <Inline value={a} mode="top" />
            </span>
          ))}
        </span>
      </Line>
      {open && (
        <div className="console-group-children">
          {row.children!.map((child) => (
            <ConsoleRow key={child.key} row={child} sessionId={sessionId} settings={settings} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One console row: gutter icon · body · source link. */
function Line({
  severity,
  entry,
  settings,
  repeat = 1,
  location,
  locationHref,
  locationLine,
  className = '',
  icon,
  onClick,
  children,
}: {
  severity: 'verbose' | 'info' | 'warning' | 'error';
  entry: ConsoleEntry;
  settings: Settings;
  repeat?: number;
  location?: string;
  locationHref?: string | undefined;
  locationLine?: number | undefined;
  className?: string;
  icon?: ReactNode;
  onClick?: () => void;
  children: ReactNode;
}) {
  const isInfoLevel = entry.type === 'console.message' && entry.level === 'info';
  return (
    <div className={`console-row severity-${severity} ${className}`} onClick={onClick} data-key={String(entry.seq)}>
      {settings.timestamps && <span className="console-timestamp" title={fullTimestamp(entry.ts)}>{formatTime(entry.ts)}</span>}
      <span className="console-gutter">
        {repeat > 1 ? (
          <span className={`console-repeat severity-${severity}`}>{repeat}</span>
        ) : (
          icon ??
          (severity === 'error' ? (
            <ErrorIcon className="console-icon error" />
          ) : severity === 'warning' ? (
            <WarnIcon className="console-icon warning" />
          ) : isInfoLevel ? (
            <InfoIcon className="console-icon info" />
          ) : null)
        )}
      </span>
      <span className="console-body">{children}</span>
      {location && locationHref && (
        <SourceLink className="console-location" url={locationHref} line={locationLine} title={locationHref}>
          {location}
        </SourceLink>
      )}
    </div>
  );
}

function stripFirstLine(stack: string): string {
  // The page's own `stack` field: typed as a string, and an array here used to
  // throw out of the error row's render.
  if (typeof stack !== 'string') return '';
  const lines = stack.split('\n');
  return /^\s*at\s|@/.test(lines[0] ?? '') ? stack : lines.slice(1).join('\n');
}
