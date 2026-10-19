/**
 * The `>` prompt that sits right after the last message, like DevTools.
 *
 *   Enter          evaluate (Shift+Enter inserts a newline)
 *   Tab / →        accept the ghost-text completion
 *   ↑ / ↓          move in the suggestion list when it is open, else walk history
 *   Esc            close suggestions
 *
 * Completions come from the page: the agent evaluates the member chain
 * before the dot and returns its property names; filtering by prefix is
 * local, so one round-trip serves a whole word.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { completions, evaluate } from '../../transport/client';
import { formatValue } from './format';
import { usePromptInbox } from '../../state/prompt-inbox';
import { completionContext, type CompletionContext } from './completion-context';
import { tokenize } from './highlight';

const HISTORY_KEY = 'bxconsole.prompt.history';
const MAX_HISTORY = 100;
const MAX_SUGGESTIONS = 12;
const MAX_HISTORY_SUGGESTIONS = 4;

/** A completion: a property of the current base, or a whole previous command. */
interface Suggestion {
  name: string;
  kind: 'prop' | 'history';
}

/** Conservative: member chains, literals and operators only. Calls, assignment and keywords with effects are excluded. */
function isSideEffectFree(expr: string): boolean {
  if (/[()=]|\+\+|--|`|\b(delete|new|throw|await|yield|import|class|function)\b/.test(expr)) return false;
  return expr.length < 200;
}

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function ConsolePrompt({
  sessionId,
  onSubmit,
  disabled,
  inputRef,
  eager = true,
}: {
  sessionId: string;
  onSubmit: (expression: string) => void;
  disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  eager?: boolean;
}) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [ctx, setCtx] = useState<CompletionContext | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(-1);
  const [popup, setPopup] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const history = useRef<string[]>(loadHistory());
  const cursor = useRef<number>(-1);
  /** what was typed before walking into history, restored when walking back out */
  const draft = useRef<string>('');
  const markerRef = useRef<HTMLSpanElement>(null);
  const requestSeq = useRef(0);

  // ---- "Edit and resend as fetch" from the Network tab drops a snippet here
  const inboxText = usePromptInbox((s) => s.text);
  useEffect(() => {
    if (inboxText === null) return;
    const text = usePromptInbox.getState().take();
    if (text === null) return;
    setValue(text);
    setCaret(text.length);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }, [inboxText, inputRef]);

  // ---- eager evaluation: preview the value of side-effect-free expressions while typing
  const [preview, setPreview] = useState<string | null>(null);
  const previewSeq = useRef(0);
  useEffect(() => {
    const expr = value.trim();
    const seq = ++previewSeq.current;
    if (!eager || disabled || !expr || !isSideEffectFree(expr)) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      void evaluate(sessionId, expr).then((reply) => {
        if (seq !== previewSeq.current) return;
        if (reply.exception || !reply.result) return setPreview(null);
        const text = formatValue(reply.result, 'preview');
        setPreview(text.length > 200 ? `${text.slice(0, 200)}…` : text);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [value, eager, disabled, sessionId]);

  // ---- completions: recompute context on every edit, fetch names per base
  useEffect(() => {
    const next = disabled ? null : completionContext(value, caret);
    setCtx(next);
    // Previous commands that start with what was typed (single line, caret at the end).
    const hist: Suggestion[] =
      !disabled && value.length >= 1 && !value.includes('\n') && caret === value.length
        ? history.current
            .filter((h) => h.startsWith(value) && h !== value)
            .slice(0, MAX_HISTORY_SUGGESTIONS)
            .map((h) => ({ name: h, kind: 'history' as const }))
        : [];
    if (!next) {
      setSuggestions(hist);
      setSelected(-1);
      return;
    }
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      void completions(sessionId, next.base).then((names) => {
        if (seq !== requestSeq.current) return; // stale
        const lower = next.prefix.toLowerCase();
        const props: Suggestion[] = names
          .filter((n) => n.toLowerCase().startsWith(lower) && n !== next.prefix)
          .slice(0, MAX_SUGGESTIONS)
          .map((n) => ({ name: n, kind: 'prop' as const }));
        setSuggestions([...props, ...hist]);
        setSelected(-1);
      });
    }, 80);
    return () => clearTimeout(timer);
  }, [value, caret, sessionId, disabled]);

  // ---- popup position from the marker in the mirror (fixed, so the scroll container never clips it)
  useLayoutEffect(() => {
    if (!suggestions.length || !markerRef.current) return setPopup(null);
    const r = markerRef.current.getBoundingClientRect();
    const above = r.bottom + 240 > window.innerHeight;
    setPopup({ left: r.left, top: above ? r.top - 2 : r.bottom + 2, above });
  }, [suggestions, value]);

  // Grow with the content instead of scrolling inside the textarea.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, inputRef]);

  const syncCaret = () => {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const accept = (sug: Suggestion) => {
    const isHist = sug.kind === 'history';
    if (!isHist && !ctx) return;
    const next = isHist ? sug.name : value.slice(0, ctx!.start) + sug.name + value.slice(caret);
    const pos = isHist ? sug.name.length : ctx!.start + sug.name.length;
    setValue(next);
    setSuggestions([]);
    setSelected(-1);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const submit = () => {
    const expression = value.trim();
    if (!expression) return;
    onSubmit(expression);
    const h = [expression, ...history.current.filter((x) => x !== expression)].slice(0, MAX_HISTORY);
    history.current = h;
    cursor.current = -1;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    } catch {
      /* ignore */
    }
    setValue('');
    setCaret(0);
    setSuggestions([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const open = suggestions.length > 0;
    const ghostName = open ? suggestions[selected >= 0 ? selected : 0] : undefined;
    const openAndSel = open && selected >= 0;

    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setSuggestions([]);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (ghostName) accept(ghostName);
      return;
    }
    if (e.key === 'ArrowRight' && ghostName && caret === value.length) {
      e.preventDefault();
      accept(ghostName);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (openAndSel) accept(suggestions[selected]!);
      else submit();
      return;
    }
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = suggestions.length;
      setSelected((s) => (e.key === 'ArrowDown' ? (s + 1) % n : (s - 1 + n) % n));
      return;
    }

    const single = !value.includes('\n');
    if (e.key === 'ArrowUp' && single) {
      const next = Math.min(cursor.current + 1, history.current.length - 1);
      if (next >= 0 && history.current[next] !== undefined) {
        e.preventDefault();
        if (cursor.current === -1) draft.current = value;
        cursor.current = next;
        setValue(history.current[next]!);
      }
    } else if (e.key === 'ArrowDown' && single && cursor.current >= 0) {
      e.preventDefault();
      const next = cursor.current - 1;
      cursor.current = next;
      setValue(next < 0 ? draft.current : history.current[next]!);
    }
  };

  const top = suggestions[selected >= 0 ? selected : 0];
  const ghost = top ? (top.kind === 'history' ? top.name.slice(value.length) : ctx ? top.name.slice(ctx.prefix.length) : '') : '';
  const markerAt = top?.kind === 'history' ? 0 : ctx?.start ?? caret;
  const tokens = tokenize(value);
  /** The mirror renders the coloured text; the textarea above it is transparent except for the caret. */
  const colored = (from: number, to: number) =>
    tokens
      .filter((t) => t.end > from && t.start < to)
      .map((t, i) => (
        <span key={`${from}-${i}`} className={`code-${t.cls}`}>
          {value.slice(Math.max(t.start, from), Math.min(t.end, to))}
        </span>
      ));

  return (
    <div className="console-prompt mono" onClick={() => inputRef.current?.focus()}>
      <span className="console-prompt-chevron">›</span>
      <div className="console-prompt-editor">
        {/* Mirror of the textarea text: positions the ghost completion and the popup marker. */}
        <div className="console-prompt-mirror" aria-hidden>
          {colored(0, markerAt)}
          <span ref={markerRef} />
          {colored(markerAt, caret)}
          <span className="console-prompt-ghost">{ghost}</span>
          {colored(caret, value.length)}
          {'\u200b'}
        </div>
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onBlur={() => setTimeout(() => setSuggestions([]), 150)}
          placeholder={disabled ? 'Session not connected' : ''}
        />
        {preview !== null && !suggestions.length && <div className="console-eager">{preview}</div>}
      </div>
      {popup && suggestions.length > 0 && (
        <div
          className={`console-suggest${popup.above ? ' above' : ''}`}
          style={{ left: popup.left, top: popup.top }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map((sug, i) => {
            const matched = sug.kind === 'history' ? value.length : ctx?.prefix.length ?? 0;
            return (
              <div
                key={`${sug.kind}:${sug.name}`}
                className={`console-suggest-item${i === selected ? ' selected' : ''}${sug.kind === 'history' ? ' history' : ''}`}
                onClick={() => accept(sug)}
                title={sug.kind === 'history' ? 'From history' : undefined}
              >
                {sug.kind === 'history' && <span className="console-suggest-hist">⟲ </span>}
                <span className="console-suggest-match">{sug.name.slice(0, matched)}</span>
                {sug.name.slice(matched)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
