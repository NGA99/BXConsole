/**
 * Serves the agent bundle with a one-line config prepended:
 *
 *   try{Object.defineProperty(self,"__wvc",{value:{"origin":"https://relay.example.com"},writable:true,configurable:true})}catch(e){}
 *
 * written that way, rather than as an assignment, for the reasons under
 * injectedHeader below.
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
 *
 * `pre` is the one that is not passed through. A payload asks for the stored
 * pre-payload with `pre=1` and gets the script in its place, so that a page
 * which can shape its own agent's URL still cannot choose what that agent
 * runs. A payload that does not ask never receives it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import { AGENT_PARAMS, INJECT_GLOBAL, type InjectedConfig } from '@bxconsole/protocol';

export type { InjectedConfig };

export function createAgentHandler(
  bundlePath: string,
  opts: {
    publicOrigin?: string | undefined;
    /** The stored pre-payload, read fresh so editing it needs no restart. */
    prePayload?: () => Promise<string | null>;
  },
) {
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
      if (key === 'pre') continue; // asked for below, never forwarded as-is
      const v = url.searchParams.get(key);
      if (v) config[key] = v;
    }
    if (url.searchParams.get('pre') === '1' && opts.prePayload) {
      const source = await opts.prePayload();
      if (source) config.pre = source;
    }
    const header = injectedHeader(config);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(header + bundle);
  };
}

/**
 * The one line that carries the configuration into the bundle.
 *
 * `self.__wvc = {…}` is the obvious way to write it and the wrong one, for
 * the two reasons a plain assignment always is. It makes an enumerable own
 * property, so the page finds the relay's address in `Object.keys(window)`
 * without having to know the name — and having to know the name is the whole
 * of what per-engagement marking buys (see the agent's mark.ts). And it goes
 * through a setter, so a page that has met this tool before can leave the
 * name trapped and be handed the configuration as it arrives.
 *
 * `defineProperty` answers both: it writes past an accessor the page left
 * behind, and what it creates is not one of the page's globals. It stays
 * `configurable` because the agent's first act is to delete it — this
 * property is meant to live for one synchronous script and no longer.
 *
 * If the page has already made the name non-configurable there is nothing to
 * be done, and nothing is attempted: assigning instead would hand the config
 * to whatever is waiting for it. An agent that arrived in a script tag still
 * finds the relay in its own `src`; one that arrived through `import()` loses
 * the run, which is the better of those two outcomes.
 */
function injectedHeader(config: InjectedConfig): string {
  const name = JSON.stringify(INJECT_GLOBAL);
  const value = JSON.stringify(config);
  return `try{Object.defineProperty(self,${name},{value:${value},writable:true,configurable:true})}catch(e){}\n`;
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
