/**
 * A `file.js:12` link. Click opens the Sources tab at that line; ⌘/Ctrl-click
 * or middle-click still opens the raw URL in a new tab.
 */
import type { ReactNode, MouseEvent } from 'react';
import { useSessionId } from '../app/session-context';
import { openSource } from '../state/sources-target';

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
    if (e.metaKey || e.ctrlKey || e.button === 1 || !sessionId || !/^(https?|file):/.test(url)) return;
    e.preventDefault();
    e.stopPropagation();
    openSource(sessionId, url, line, col);
  };
  return (
    <a className={className} href={url} target="_blank" rel="noreferrer" title={title ?? url} onClick={onClick}>
      {children}
    </a>
  );
}
