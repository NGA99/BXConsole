/**
 * The source viewer draws one row per line and puts the line number in that
 * row, so a fragment count that does not match the text's line count
 * misnumbers the whole file without anything looking broken. These pin the
 * count, and that spans are closed and reopened across newlines so a comment
 * does not colour the rest of the file.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import { splitHighlightedLines } from '../src/devtools-ui/code-lines';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);

/** Every `<span …>` opened in a fragment is closed inside that same fragment. */
function balanced(fragment: string): boolean {
  let depth = 0;
  for (const tag of fragment.match(/<\/?span[^>]*>/g) ?? []) {
    depth += tag.startsWith('</') ? -1 : 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const SAMPLES: Array<[string, string]> = [
  [
    'javascript',
    `/*\n * A block comment spanning\n * several lines.\n */\nconst a = {\n  b: 'a string\\nnot a newline',\n};\n\nfunction f() {\n  return \`a template\n  over two lines\`;\n}\n`,
  ],
  ['css', `/* a\n   comment */\n.a,\n.b {\n  color: red;\n  background: url("x.png");\n}\n`],
  ['xml', `<!doctype html>\n<html>\n  <!-- a\n       comment -->\n  <body class="a\nb">text</body>\n</html>\n`],
];

describe('splitting highlighted lines', () => {
  for (const [language, code] of SAMPLES) {
    test(`${language}: one fragment per line, each self-contained`, () => {
      const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      const lines = splitHighlightedLines(html);
      assert.equal(lines.length, code.split('\n').length, 'fragment count must match line count');
      for (const [i, line] of lines.entries()) assert.ok(balanced(line), `line ${i + 1} leaves a span open: ${line}`);
      // Nothing of the text is lost on the way.
      const text = lines.join('\n').replace(/<[^>]*>/g, '');
      assert.equal(text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), code);
    });
  }

  test('plain text with no markup', () => {
    assert.deepEqual(splitHighlightedLines('a\nb\nc'), ['a', 'b', 'c']);
    assert.deepEqual(splitHighlightedLines(''), ['']);
    assert.deepEqual(splitHighlightedLines('\n'), ['', '']);
  });

  test('a span across a newline is closed and reopened', () => {
    const out = splitHighlightedLines('<span class="hljs-comment">a\nb</span>');
    assert.deepEqual(out, ['<span class="hljs-comment">a</span>', '<span class="hljs-comment">b</span>']);
  });

  test('an unterminated tag is kept rather than swallowing the rest', () => {
    const out = splitHighlightedLines('ok <span class="x');
    assert.equal(out.length, 1);
    assert.ok(out[0]!.startsWith('ok <span class="x'));
  });
});
