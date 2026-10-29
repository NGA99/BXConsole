/**
 * What a URL's file is called: the last segment of its path.
 *
 * For a list that is naming files — the Sources tree, the Network search's
 * groups. It was the same seven lines in both of those, written twice.
 *
 * Not the Network list's Name column, which is `nameOf` in panels/network/
 * classify: that one keeps the query string, because two rows on one endpoint
 * are told apart by it and `search` beside `search` is not a list. Nor the
 * Console sidebar's source counts, which group by host and path together, so
 * two files of the same name from two origins stay apart. Three questions
 * that sound alike and are not; this is the one that asks for a file name.
 */
export function fileName(url: string): string {
  try {
    const u = new URL(url);
    // A path of `/` has no segments, and the page it serves is the index.
    return u.pathname.split('/').filter(Boolean).pop() ?? '(index)';
  } catch {
    // Not a URL at all — an inline script's placeholder, say. Whatever it is
    // is the best name available for it.
    return url;
  }
}
