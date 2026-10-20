/**
 * A `file.js:12` link. Click opens the Sources tab at that line; ⌘/Ctrl-click
 * or middle-click still opens the raw URL in a new tab.
 */
import type { ReactNode, MouseEvent } from 'react';
import { useSessionId } from '../app/session-context';
import { openSource } from '../state/sources-target';
import { safeHref } from './safe-url';

export function SourceLink({
  url,
  line,
  col,
  className = 'source-link',
  title,
  children,
}: {
  url: string;
  line?: number;
  col?: number;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const sessionId = useSessionId();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Narrower than the href check below on purpose: that one asks whether a
    // browser may be pointed at this URL, this one whether Sources could hold
    // the file. A frame from `ws:` is linkable and still not a source.
    if (e.metaKey || e.ctrlKey || e.button === 1 || !sessionId || !/^(https?|file):/.test(url)) return;
    e.preventDefault();
    e.stopPropagation();
    openSource(sessionId, url, line, col);
  };
  return (
    // No href for a scheme the browser would run instead of fetch: these
    // URLs come out of the debugged page's stack traces and requests, and a
    // page that wants the investigator's console only has to claim a frame
    // came from `javascript:…`. The modifier-click path below bypasses
    // onClick by design, so the attribute itself has to be safe.
    <a className={className} href={safeHref(url)} target="_blank" rel="noreferrer" title={title ?? url} onClick={onClick}>
      {children}
    </a>
  );
}
