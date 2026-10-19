/**
 * Splitting highlighted HTML into one fragment per source line.
 *
 * Its own module because it is the one piece of the source viewer that can be
 * wrong without looking wrong: the viewer draws a row per line, so a fragment
 * count that drifts from the text's line count silently misnumbers the whole
 * file, and a span left open bleeds its colour down the rest of it.
 */

/**
 * One fragment per line, with whatever spans straddle a newline closed at the
 * end of the line and reopened at the start of the next. The input is
 * highlight.js output: balanced `<span class=…>` tags around escaped text.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end < 0) {
        // Not a tag after all; keep it verbatim rather than losing the tail.
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) open.pop();
      else if (!tag.endsWith('/>')) open.push(tag);
      cur += tag;
      i = end + 1;
    } else if (ch === '\n') {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
      i++;
    } else {
      const lt = html.indexOf('<', i);
      const nl = html.indexOf('\n', i);
      const stop = Math.min(lt < 0 ? html.length : lt, nl < 0 ? html.length : nl);
      cur += html.slice(i, stop);
      i = stop;
    }
  }
  lines.push(cur + '</span>'.repeat(open.length));
  return lines;
}
