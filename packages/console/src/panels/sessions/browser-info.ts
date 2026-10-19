/**
 * What the agent's user agent string says about where a run happened.
 *
 * On a blind XSS run this is often the only thing you know about the person
 * whose browser ran the payload — which build of which browser, on which
 * operating system. "Chrome" alone does not distinguish an admin on a managed
 * Windows desktop from the same person's phone, and those are different
 * findings.
 *
 * Deliberately shallow. A user agent is a string the client chose to send, so
 * it is evidence rather than fact, and a parser that tries to be clever about
 * it mostly succeeds at being confidently wrong.
 */

export interface BrowserInfo {
  /** "Chrome", "Safari", "Firefox"… or "Unknown" when nothing matches */
  browser: string;
  /** major version only; minor parts move constantly and say nothing */
  version: string | null;
  /** "macOS", "Windows 11", "Android 14"… or null */
  os: string | null;
  mobile: boolean;
}

/**
 * Order matters. Every Chromium browser claims to be Chrome and Safari, and
 * Edge and Opera add their own token at the end — so the most specific token
 * has to be tested first or everything reads as Chrome.
 */
const BROWSERS: Array<[name: string, re: RegExp]> = [
  ['Edge', /Edg(?:[A-Z]{1,2})?\/(\d+)/],
  ['Opera', /OPR\/(\d+)/],
  ['Samsung Internet', /SamsungBrowser\/(\d+)/],
  ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
  ['Safari', /Version\/(\d+).*Safari\//],
];

export function browserInfo(ua: string): BrowserInfo {
  const mobile = /Mobile|Android|iPhone|iPad|iPod/.test(ua);
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) return { browser: name, version: m[1] ?? null, os: osOf(ua), mobile };
  }
  // A headless tool, a crawler, or a page that overrode navigator.userAgent.
  return { browser: 'Unknown', version: null, os: osOf(ua), mobile };
}

function osOf(ua: string): string | null {
  const android = /Android (\d+)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  const ios = /OS (\d+)[._]\d+ like Mac OS X/.exec(ua);
  if (ios) return `iOS ${ios[1]}`;
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  /*
   * Windows 11 reports itself as 10.0 and has done since it shipped; the two
   * are not distinguishable from the user agent, so neither is claimed.
   */
  const win = /Windows NT (\d+\.\d+)/.exec(ua);
  if (win) return win[1] === '10.0' ? 'Windows 10/11' : `Windows NT ${win[1]}`;
  // Mac versions froze at 10_15_7 for fingerprinting reasons, so the number
  // would be a lie even where it is present.
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/** "Chrome 155", or just the name when the version is not in the string. */
export function browserLabel(info: BrowserInfo): string {
  const name = info.mobile && info.browser !== 'Unknown' ? `${info.browser} Mobile` : info.browser;
  return info.version ? `${name} ${info.version}` : name;
}

/**
 * The second line: where it ran and how big the window was.
 *
 * A zero viewport is what a recording made before the window reported its
 * size looks like. Showing "0×0" states something false about the page; it is
 * left out instead.
 */
export function platformLabel(info: BrowserInfo, viewport: { width: number; height: number }): string {
  const size = viewport.width > 0 && viewport.height > 0 ? `${viewport.width}×${viewport.height}` : null;
  return [info.os, size].filter(Boolean).join(' · ');
}
