/**
 * Every parameter the agent reads out of its own URL.
 *
 * Named once because three places have to agree and, for a while, did not:
 * the console writes these into a snippet, the relay forwards them when it
 * serves agent.js to a page that has no script tag to read, and the agent
 * parses them. The relay's copy of the list was four names short, so
 * `frame`, `adopt`, `collect`, `session` and `tab` were silently dropped from
 * every `import()`, `fetch()` and bookmarklet — the option simply did nothing,
 * and with hosting on by default that meant trying to frame pages that refuse
 * to be framed.
 */
export const AGENT_PARAMS = ['name', 'server', 'bodies', 'screen', 'adopt', 'collect', 'frame', 'session', 'tab', 'mark', 'pre'] as const;

export type AgentParam = (typeof AGENT_PARAMS)[number];

/**
 * The global the relay prepends the configuration to.
 *
 * This one name cannot be derived from `mark`, because the mark is read out
 * of it — so it is fixed, and therefore deliberately dull. A fixed name is
 * exactly what the mark exists to avoid, and it would undo every renamed
 * trace on its own: one grep for every host this tool has ever been pasted
 * into, whatever `data-mark` said that day.
 *
 * What saves it is that it does not last. The relay defines it rather than
 * assigning it, so it is not one of the page's own globals while it is there,
 * and the agent takes it off the window before it reads anything else. None
 * of the page's code runs in between, so the window in which it could be
 * found does not exist. See the relay's agent-handler and the agent's
 * readConfig for the two halves.
 */
export const INJECT_GLOBAL = '__wvc';

/**
 * What the relay prepends to the bundle as `self.<INJECT_GLOBAL>`.
 *
 * `pre` means two different things either side of the relay, and the relay is
 * what translates: a payload asks for the pre-payload with `pre=1`, and what
 * comes back in its place is the script itself. The source is never taken
 * from the URL — a page that can influence its own agent's URL must not be
 * able to choose what that agent runs, so only the relay supplies it.
 */
export type InjectedConfig = Partial<Record<AgentParam, string>> & {
  origin: string;
  /**
   * Script to run the moment the agent is installed, before anyone is
   * watching. See PRE_PAYLOAD_FILE for what it is for and what it costs.
   */
  pre?: string;
};
