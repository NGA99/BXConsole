/**
 * Selector arithmetic: splitting a selector list and scoring specificity.
 *
 * Kept apart from the rest of the Elements support because it is pure string
 * work with no DOM in it, which is the only reason it can be tested at all —
 * and it is the part that decides which declarations the Styles pane strikes
 * out, so being quietly wrong here is invisible until someone is debugging a
 * cascade problem with it.
 */

export function splitSelectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function specificity(selector: string): [number, number, number] {
  // An escaped character is not a selector character.
  let s = selector.replace(/\\./g, ' ');
  let total: [number, number, number] = [0, 0, 0];

  // :where() adds nothing, inside or out.
  s = takeFunctional(s, /:where\(/i, ' ', () => {});

  /*
   * :is() / :not() / :has() take the specificity of their MOST SPECIFIC
   * argument — not the sum of them, and the pseudo-class itself does not count
   * on top. Summing made `:is(h1, h2, h3)` score as three elements, which is
   * enough to flip the cascade against a selector that should have won.
   */
  s = takeFunctional(s, /:(?:not|is|matches|has|-[\w-]+-any)\(/i, ' ', (inner) => {
    const best = splitSelectorList(inner)
      .map(specificity)
      .reduce<[number, number, number]>((a, b) => (compareSpec(a, b) >= 0 ? a : b), [0, 0, 0]);
    total = add(total, best);
  });

  // Any other functional pseudo-class counts as one pseudo-class, and its
  // argument is not a selector: nth-child's "2n+1", lang's "en".
  s = takeFunctional(s, /:[\w-]+\(/, ':fn', () => {});

  // Attribute selectors first: a '#' or '.' inside one is text, not a
  // selector ([href="#top"] used to read as an id).
  const attrs = (s.match(/\[[^\]]*\]/g) ?? []).length;
  s = s.replace(/\[[^\]]*\]/g, ' ');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+/g) ?? []).length;
  const pseudoElements = (s.match(/::[\w-]+/g) ?? []).length;
  const pseudoClasses = (s.replace(/::[\w-]+/g, ' ').match(/:[\w-]+/g) ?? []).length;
  const elements = (s.replace(/[#.:][\w-]+/g, ' ').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return add(total, [ids, classes + attrs + pseudoClasses, elements + pseudoElements]);
}

function add(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * Replace every `:name(...)` the pattern matches with `replacement`, handing
 * the balanced inner text to `take`. Balanced, not a regex: the argument of
 * one of these may hold parentheses of its own.
 */
function takeFunctional(selector: string, name: RegExp, replacement: string, take: (inner: string) => void): string {
  let s = selector;
  for (;;) {
    const m = name.exec(s);
    if (!m) return s;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return s.slice(0, m.index); // unbalanced: the rest is unusable
    take(s.slice(open + 1, end));
    s = s.slice(0, m.index) + replacement + s.slice(end + 1);
  }
}

export function compareSpec(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
