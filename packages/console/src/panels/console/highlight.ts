/** Tiny JS tokenizer for the prompt's syntax colouring. Good enough for one-liners; never throws. */

export interface Token {
  start: number;
  end: number;
  cls: 'string' | 'number' | 'keyword' | 'comment' | 'property' | 'punct' | 'ident' | 'regexp' | 'text';
}

const KEYWORDS = new Set(
  'await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield true false null undefined NaN Infinity'.split(' '),
);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (end: number, cls: Token['cls']) => {
    if (end > i) out.push({ start: i, end, cls });
    i = end;
  };
  while (i < src.length) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      push(nl < 0 ? src.length : nl, 'comment');
    } else if (two === '/*') {
      const e = src.indexOf('*/', i + 2);
      push(e < 0 ? src.length : e + 2, 'comment');
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      push(Math.min(src.length, j + 1), 'string');
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9a-fA-FxXn_.eE]/.test(src[j]!)) j++;
      push(j, 'number');
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      const afterDot = /\.\s*$/.test(src.slice(0, i));
      push(j, afterDot ? 'property' : KEYWORDS.has(word) ? 'keyword' : 'ident');
    } else if (/[{}()[\];,.<>=+\-*/%!&|^~?:]/.test(c)) {
      push(i + 1, 'punct');
    } else {
      push(i + 1, 'text');
    }
  }
  return out;
}
