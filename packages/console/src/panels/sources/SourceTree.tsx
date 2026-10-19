/**
 * Chrome-style navigator: top → host → path folders → files. Hosts and
 * folders collapse; the page's own host is open by default; while filtering,
 * every ancestor of a match is open.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { SourceEntry } from '@bxconsole/protocol';

interface TreeNode {
  key: string;
  name: string;
  kind: 'root' | 'host' | 'folder' | 'inline' | 'file';
  children: TreeNode[];
  entry?: SourceEntry;
}

export function SourceTree({
  entries,
  filter,
  current,
  pageHost,
  onOpen,
}: {
  entries: SourceEntry[];
  filter: string;
  current: string | null;
  pageHost: string;
  onOpen: (url: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [opened, setOpened] = useState<Set<string>>(() => new Set());

  const root = useMemo(() => buildTree(entries, filter), [entries, filter]);
  const filtering = filter.trim().length > 0;

  const isOpen = (n: TreeNode): boolean => {
    // A collapse the user made is honoured whether or not a filter is on.
    // Short-circuiting on `filtering` first meant a click while filtering
    // changed nothing on screen but was still recorded, so the folder turned
    // out to be collapsed once the filter was cleared.
    if (collapsed.has(n.key)) return false;
    if (filtering) return true;
    if (opened.has(n.key)) return true;
    // defaults: root open, the page's host open (with its folders), other hosts closed
    if (n.kind === 'root') return true;
    if (n.kind === 'host') return n.name === pageHost;
    if (n.kind === 'folder' || n.kind === 'inline') return n.key.startsWith(`top/${pageHost}/`);
    return false;
  };
  const toggle = (n: TreeNode) => {
    const open = isOpen(n);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.add(n.key);
      else next.delete(n.key);
      return next;
    });
    setOpened((prev) => {
      const next = new Set(prev);
      if (open) next.delete(n.key);
      else next.add(n.key);
      return next;
    });
  };

  const rows: ReactNode[] = [];
  const walk = (n: TreeNode, depth: number) => {
    const open = isOpen(n);
    const hasChildren = n.children.length > 0;
    rows.push(
      <div
        key={n.key}
        className={`sources-node ${n.kind}${n.entry && n.entry.url === current ? ' selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={n.entry?.url ?? n.name}
        onClick={() => (n.kind === 'file' && n.entry ? onOpen(n.entry.url) : toggle(n))}
      >
        <span className={`sources-arrow${hasChildren ? (open ? ' open' : '') : ' hidden'}`} />
        <NodeIcon node={n} />
        <span className="sources-name">{n.name}</span>
      </div>,
    );
    if (open) for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return <div className="sources-tree mono">{rows}</div>;
}

function buildTree(entries: SourceEntry[], filter: string): TreeNode {
  const f = filter.trim().toLowerCase();
  const root: TreeNode = { key: 'top', name: 'top', kind: 'root', children: [] };
  const hostNode = (host: string): TreeNode => {
    let h = root.children.find((c) => c.name === host);
    if (!h) {
      h = { key: `top/${host}`, name: host, kind: 'host', children: [] };
      root.children.push(h);
    }
    return h;
  };
  for (const e of entries) {
    if (f && !e.url.toLowerCase().includes(f) && !e.label.toLowerCase().includes(f)) continue;
    let host = '(other)';
    let segments: string[] = [];
    let name = e.label;
    if (e.inline) {
      host = pageHostOf(entries);
      segments = ['(inline)'];
    } else {
      try {
        const u = new URL(e.url);
        host = u.host;
        const parts = u.pathname.split('/').filter(Boolean);
        if (e.kind === 'document' || parts.length === 0 || u.pathname.endsWith('/')) {
          segments = parts;
          name = '(index)';
        } else {
          segments = parts.slice(0, -1);
          name = decodeURIComponent(parts[parts.length - 1]!) + (u.search ? `?${u.search.slice(1, 9)}${u.search.length > 9 ? '…' : ''}` : '');
        }
      } catch {
        name = e.url;
      }
    }
    let node = hostNode(host);
    for (const seg of segments) {
      const key = `${node.key}/${seg}`;
      let child = node.children.find((c) => c.key === key && c.kind !== 'file');
      if (!child) {
        child = { key, name: seg, kind: seg === '(inline)' ? 'inline' : 'folder', children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ key: `${node.key}/${e.url}`, name, kind: 'file', children: [], entry: e });
  }
  sortTree(root);
  return root;
}

function sortTree(n: TreeNode): void {
  // folders first, then files; alphabetical; (index) first among files
  n.children.sort((a, b) => {
    const af = a.kind === 'file' ? 1 : 0;
    const bf = b.kind === 'file' ? 1 : 0;
    if (af !== bf) return af - bf;
    if (a.name === '(index)') return -1;
    if (b.name === '(index)') return 1;
    return a.name.localeCompare(b.name);
  });
  n.children.forEach(sortTree);
}

function pageHostOf(entries: SourceEntry[]): string {
  const doc = entries.find((e) => e.kind === 'document' && !e.inline);
  try {
    return doc ? new URL(doc.url).host : '(page)';
  } catch {
    return '(page)';
  }
}

function NodeIcon({ node }: { node: TreeNode }) {
  switch (node.kind) {
    case 'root':
      return (
        <svg className="sources-icon" width="14" height="14" viewBox="0 0 14 14">
          <rect x="1.5" y="3" width="11" height="8.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1.5 5.5h11" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case 'host':
      return (
        <svg className="sources-icon" width="14" height="14" viewBox="0 0 14 14">
          <path d="M4 11h6.5a2.5 2.5 0 0 0 .4-5A3.5 3.5 0 0 0 4.2 5.2 3 3 0 0 0 4 11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case 'folder':
    case 'inline':
      return (
        <svg className="sources-icon" width="14" height="14" viewBox="0 0 14 14">
          <path d="M1.5 3.5h4l1.5 1.5h5.5v6h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    default: {
      const kind = node.entry?.kind ?? 'document';
      return <span className={`sources-kind ${kind}`}>{kind === 'document' ? '◧' : kind === 'script' ? 'JS' : 'CSS'}</span>;
    }
  }
}
