/** Call stack of page code, with the agent's own frames removed. */
import type { AgentConfig } from './config';

export function captureStack(config: AgentConfig, skipFirst = 0): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack
    .split('\n')
    .filter((line) => {
      if (/^Error\s*$/.test(line)) return false; // V8's first line
      if (config.scriptSrc && line.includes(config.scriptSrc)) return false;
      if (line.includes('/agent.js')) return false;
      return true;
    })
    .slice(skipFirst);
  return lines.length ? lines.join('\n') : undefined;
}
