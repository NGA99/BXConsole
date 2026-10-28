/**
 * A window's address, split where the address bar wants to break it.
 *
 * A browser draws the host in the plain ink and dims the rest, because the
 * host is the fact that matters and a path can be long enough to push it off
 * the end. The two halves are returned separately so the bar can do the same.
 *
 * It used to stop at the path, which threw away the query — and the query is
 * often the only thing telling two windows of a run apart. Three tabs all
 * titled "Example Domain" on `/?1`, `/?2` and `/?3` showed as the same host
 * three times, which is worse than showing nothing.
 *
 * The scheme is dropped on https, where it says nothing, and kept on anything
 * else: a run on plain http is a fact about the engagement.
 */
export interface Address {
  /** the scheme, unless it is https, and the host */
  head: string;
  /** the path, query and fragment — everything the host does not say */
  tail: string;
}

export function address(url: string): Address {
  try {
    const u = new URL(url);
    /*
     * No host to put in the head, so there is nothing to split.
     *
     * `about:blank` parses — it is a URL, just not one with an authority —
     * and splitting it anyway produced the invented "about://" followed by
     * "blank". A window sits on about:blank for real, in the moment between
     * being opened and being navigated, so this is a page the strip shows.
     */
    if (!u.host) return { head: url, tail: '' };
    const scheme = u.protocol === 'https:' ? '' : `${u.protocol}//`;
    // A bare "/" is noise, but not once there is a query hanging off it.
    const path = u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname;
    return { head: scheme + u.host, tail: path + u.search + u.hash };
  } catch {
    /*
     * Not a URL the browser can parse. Shown whole rather than dropped: the
     * agent reports whatever the page said its address was, and on a run that
     * went somewhere strange that string is the finding.
     */
    return { head: url, tail: '' };
  }
}
