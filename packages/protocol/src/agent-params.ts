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
export const AGENT_PARAMS = ['name', 'server', 'bodies', 'screen', 'adopt', 'collect', 'frame', 'session', 'tab', 'mark'] as const;

export type AgentParam = (typeof AGENT_PARAMS)[number];

/**
 * The global the relay prepends the configuration to.
 *
 * This one cannot be derived from `mark`, because the mark is read out of it
 * — so it is fixed, and therefore deliberately dull. It is the one trace a
 * page can always look for, which is the price of configuring an agent that
 * has no script tag to read.
 */
export const INJECT_GLOBAL = '__wvc';

/** What the relay prepends to the bundle as `self.<INJECT_GLOBAL>`. */
export type InjectedConfig = Partial<Record<AgentParam, string>> & { origin: string };
