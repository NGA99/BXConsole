/**
 * Minimal static file server. Longest matching mount prefix wins.
 * A mount that points at a file serves that file; one that points at a
 * directory serves files under it with index.html fallback.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createStaticHandler(mounts: Record<string, string>) {
  const sorted = Object.entries(mounts).sort((a, b) => b[0].length - a[0].length);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const mount = sorted.find(([prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix));
    if (!mount) return notFound(res);

    const [prefix, target] = mount;
    let filePath: string;
    try {
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.isFile()) {
        filePath = target;
      } else {
        const rel = decodeURIComponent(url.pathname.slice(prefix.length));
        filePath = path.join(target, rel);
        // startsWith alone lets a sibling that shares the prefix through:
        // `<...>/console/dist-secret` passes a check against `<...>/console/dist`.
        if (filePath !== target && !filePath.startsWith(target + path.sep)) return notFound(res);
        const s = await fs.stat(filePath).catch(() => null);
        if (!s) return notFound(res);
        if (s.isDirectory()) filePath = path.join(filePath, 'index.html');
      }
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      notFound(res);
    }
  };
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}
