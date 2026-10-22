/**
 * What a window's tab says about it, in the two places there is room.
 *
 * Its own file so the rules can be tested: tests here cannot import a .tsx,
 * and these are the parts with decisions in them rather than markup.
 */
import type { SessionTab } from '@bxconsole/protocol';
import { plain } from '../devtools-ui/plain-text';

/**
 * A count that has to read at a glance in eleven pixels of space.
 *
 * Thousands are the ordinary case for a window that ran for a while — one
 * here reached 1,902 — and four digits crowd out the title they are meant to
 * qualify. The exact figure is a hover away; what the tab needs to carry is
 * the difference between a window that did something and one that did not.
 */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  // Each boundary is 999,500 rather than a round million, because the step up
  // has to happen before rounding does: 999,999 scaled into thousands rounds
  // to 1000 and comes out as "1000k", which is both wrong and five characters.
  if (n < 999_500) return `${short(n / 1000)}k`;
  if (n < 999_500_000) return `${short(n / 1_000_000)}M`;
  return `${short(n / 1_000_000_000)}B`;
}

/** One decimal while that says something, none once it does not. */
function short(x: number): string {
  return String(x < 10 ? Number(x.toFixed(1)) : Math.round(x));
}

/** Everything about a window that will not fit on its tab. */
export function describe(tab: SessionTab, events: number): string {
  const lines = [plain(tab.title || tab.url), plain(tab.url)];
  const ms = Math.max(0, tab.lastSeenAt - tab.startedAt);
  lines.push(`${events.toLocaleString()} events over ${duration(ms)}`);
  if (tab.openedBy) lines.push('Opened by another window of this run');
  if (tab.viewport) lines.push(`Viewport ${tab.viewport.width}×${tab.viewport.height}`);
  lines.push(tab.connected ? 'Still open' : 'Closed');
  return lines.join('\n');
}

/** Rounded the way someone reads a duration aloud, not to the millisecond. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
