/**
 * Serves the agent bundle with a one-line config prepended:
 *
 *   self.__wvc = {"origin":"https://relay.example.com","name":"checkout"};
 *
 * The origin is the address the request arrived on (honouring X-Forwarded-*
 * behind a proxy, or PUBLIC_ORIGIN when set), so the same file works whether
 * it was loaded by a <script> tag, `import()`, or a bookmarklet, from any
 * page, without the agent having to find its own script tag.
 *
 * Every query parameter the agent understands becomes config too, from the
 * one shared list — this used to be a second copy of the names, and it fell
 * four short, so `frame`, `adopt` and `collect` did nothing at all when the
 * agent was loaded by `import()` or a bookmarklet rather than a script tag.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import { AGENT_PARAMS, INJECT_GLOBAL, type InjectedConfig } from '@bxconsole/protocol';

export type { InjectedConfig };

export function createAgentHandler(bundlePath: string, opts: { publicOrigin?: string | undefined }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let bundle: string;
    try {
      bundle = await fs.readFile(bundlePath, 'utf8');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('agent bundle not built: run `npm run build -w @bxconsole/agent`');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const config: InjectedConfig = { origin: opts.publicOrigin ?? requestOrigin(req) };
    for (const key of AGENT_PARAMS) {
      const v = url.searchParams.get(key);
      if (v) config[key] = v;
    }
    const header = `self.${INJECT_GLOBAL}=${JSON.stringify(config)};\n`;
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(header + bundle);
  };
}

/** Where this request reached us, as seen from the outside. */
export function requestOrigin(req: IncomingMessage): string {
  const forwardedProto = first(req.headers['x-forwarded-proto']);
  const forwardedHost = first(req.headers['x-forwarded-host']);
  const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
  const proto = forwardedProto ?? (encrypted ? 'https' : 'http');
  const host = forwardedHost ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}
