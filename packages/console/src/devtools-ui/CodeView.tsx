/**
 * Source viewer like the Network Response tab in Chrome: language detected
 * from the MIME type (with content sniffing as fallback), highlight.js
 * colouring, line numbers, and an optional pretty-print via js-beautify.
 */
import { useEffect, useMemo, useRef } from 'react';
import hljs from 'highlight.js/lib/core';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import { js as beautifyJs, css as beautifyCss, html as beautifyHtml } from 'js-beautify';
import { splitHighlightedLines } from './code-lines';
import './CodeView.css';

hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);

export type CodeLanguage = 'html' | 'css' | 'javascript' | 'json' | 'xml' | 'plain';

export function detectLanguage(mimeType: string | undefined, sample: string): CodeLanguage {
  const m = (mimeType ?? '').toLowerCase();
  if (m.includes('json')) return 'json';
  if (m.includes('javascript') || m.includes('ecmascript')) return 'javascript';
  if (m.includes('css')) return 'css';
  if (m.includes('html')) return 'html';
  if (m.includes('xml') || m.includes('svg')) return 'xml';
  const head = sample.slice(0, 2000).trimStart();
  if (/^<!doctype html|^<html|^<head|^<body/i.test(head)) return 'html';
  if (/^<\?xml|^<svg/i.test(head)) return 'xml';
  if (/^[\[{]/.test(head)) {
    // Brackets that balance at the ends, before anything expensive: a full
    // parse of a multi-megabyte response, only to pick a highlighter, is a
    // visible freeze on a big API payload.
    const closes = head[0] === '{' ? '}' : ']';
    if (sample.trimEnd().endsWith(closes)) {
      if (sample.length > 256_000) return 'json';
      try {
        JSON.parse(sample);
        return 'json';
      } catch {
        /* not JSON after all */
      }
    }
  }
  if (/^(import |export |const |let |var |function |\(function|!function|"use strict")/m.test(head)) return 'javascript';
  if (/^[.#@a-z][^{]*\{[^}]*\}/m.test(head)) return 'css';
  return 'plain';
}

export function canFormat(lang: CodeLanguage): boolean {
  return lang === 'json' || lang === 'javascript' || lang === 'css' || lang === 'html' || lang === 'xml';
}

export function formatCode(code: string, lang: CodeLanguage): string {
  try {
    switch (lang) {
      case 'json':
        return JSON.stringify(JSON.parse(code), null, 2);
      case 'javascript':
        return beautifyJs(code, { indent_size: 2 });
      case 'css':
        return beautifyCss(code, { indent_size: 2 });
      case 'html':
      case 'xml':
        return beautifyHtml(code, { indent_size: 2, wrap_line_length: 0 });
      default:
        return code;
    }
  } catch {
    return code;
  }
}

export function CodeView({
  code,
  language,
  wrap = false,
  activeLine,
  activeNonce = 0,
  matches,
}: {
  code: string;
  language: CodeLanguage;
  wrap?: boolean;
  /** 1-based line to highlight and scroll into view */
  activeLine?: number;
  /** change to re-scroll to the same line */
  activeNonce?: number;
  /** 1-based lines with search matches, marked in the gutter */
  matches?: Set<number>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const lang = language === 'html' ? 'xml' : language;
    if (lang === 'plain' || code.length > 500_000) return code.split('\n').map(escapeHtml);
    try {
      return splitHighlightedLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
    } catch {
      return code.split('\n').map(escapeHtml);
    }
  }, [code, language]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !activeLine) return;
    // Measured, not multiplied: with wrapping on, a line is as tall as it needs to be.
    const row = el.querySelector<HTMLElement>(`[data-line="${activeLine}"]`);
    if (!row) return;
    const top = row.offsetTop;
    if (top < el.scrollTop + 40 || top + row.offsetHeight > el.scrollTop + el.clientHeight - 20) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }
  }, [activeLine, activeNonce, lines]);

  return (
    <div className={`codeview${wrap ? ' wrap' : ''}`} ref={scroller}>
      <div className="codeview-lines mono">
        {lines.map((html, i) => (
          <div
            key={i}
            data-line={i + 1}
            className={`codeview-line${activeLine === i + 1 ? ' active' : ''}${matches?.has(i + 1) ? ' match' : ''}`}
          >
            <span className="codeview-ln" aria-hidden>
              {i + 1}
            </span>
            <code className="codeview-text" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
