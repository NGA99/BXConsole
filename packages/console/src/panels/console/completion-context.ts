/**
 * What to complete at the caret: the member chain before the last dot
 * (`base`, evaluated in the page) and the identifier being typed (`prefix`).
 *
 *   "document.bo|"        -> base "document",      prefix "bo"
 *   "document.body.|"     -> base "document.body", prefix ""
 *   "win|"                -> base "",              prefix "win"   (global scope)
 *   "foo().|"             -> null  (evaluating the base would call foo)
 */
export interface CompletionContext {
  base: string;
  prefix: string;
  /** index in the text where `prefix` starts */
  start: number;
}

const IDENT_CHAR = /[\w$]/;

export function completionContext(text: string, caret: number): CompletionContext | null {
  // Only complete at the end of a word.
  if (caret < text.length && IDENT_CHAR.test(text[caret]!)) return null;

  let i = caret;
  while (i > 0 && IDENT_CHAR.test(text[i - 1]!)) i--;
  const prefix = text.slice(i, caret);
  if (/^\d/.test(prefix)) return null;
  const start = i;

  let base = '';
  if (i > 0 && text[i - 1] === '.') {
    let j = i - 1;
    let depth = 0;
    while (j > 0) {
      const c = text[j - 1]!;
      if (c === ']') depth++;
      else if (c === '[') depth--;
      else if (depth === 0 && !IDENT_CHAR.test(c) && c !== '.') break;
      if (depth < 0) break;
      j--;
    }
    base = text.slice(j, i - 1);
    if (!base || /[()=]/.test(base)) return null;
  }

  if (!base && !prefix) return null;
  return { base, prefix, start };
}
