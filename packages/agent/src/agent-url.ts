/**
 * The agent URL for another window of the same run.
 *
 * A window this one opens, or that opened it, loads the agent from a URL this
 * one builds. Everything the run was configured with has to be written into
 * that URL, because nothing else will ever tell the new window: a script tag
 * carries its choices as `data-*` attributes, and none of that survives into
 * a `src` string.
 *
 * Getting this wrong is quiet. The second window joins the right session and
 * behaves slightly differently from the first — not recording, not capturing
 * bodies — and the recording looks like the page misbehaved.
 */
import type { AgentConfig } from './config';

export function agentUrl(config: AgentConfig, sessionId: string, base: string): string {
  const src = config.scriptSrc ?? '/agent.js';
  try {
    const u = new URL(src, base);
    // The new window is its own window; it must not inherit this one's id.
    u.searchParams.delete('tab');
    // The session is named explicitly because an ancestor was opened before
    // we existed and has nothing in sessionStorage to inherit — without this
    // each window would start a session of its own instead of joining the run.
    u.searchParams.set('session', sessionId);
    if (config.name) u.searchParams.set('name', config.name);
    else u.searchParams.delete('name');
    // The rest of the run's choices. These are on unless turned off, so only
    // the off-switches travel and the URL stays readable — hosting below is
    // the one that is off by default and travels when on.
    setFlag(u, 'screen', config.screen !== 'record', 'viewer');
    setFlag(u, 'bodies', !config.captureBodies, '0');
    setFlag(u, 'collect', !config.collect, '0');
    setFlag(u, 'adopt', !config.adopt, '0');
    // Hosting travels too, but as an on-switch: it is off by default, so a run
    // that turned it on must say so, or a window this one opened would default
    // back to off and leave its own navigations out of the run.
    setFlag(u, 'frame', config.frame === 'host', 'host');
    // Every window of a run must leave the same trace, or the page can tell
    // the windows apart by how they were marked.
    if (config.mark) u.searchParams.set('mark', config.mark);
    else u.searchParams.delete('mark');
    return u.href;
  } catch {
    return src;
  }
}

/** Set the parameter when the choice is not the default, and clear it when it is. */
function setFlag(u: URL, key: string, on: boolean, value: string): void {
  if (on) u.searchParams.set(key, value);
  else u.searchParams.delete(key);
}
