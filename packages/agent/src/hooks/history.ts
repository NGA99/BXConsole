/**
 * History tab recording: what the user did, light performance observations,
 * and app annotations. Everything here is cheap to observe; summaries are
 * computed by the viewer, not in the page.
 *
 * Printable typing is never recorded as key events (inputs cover it).
 */
import type { AgentEvent } from '@bxconsole/protocol';
import { serialize } from '../serialize';
import type { Transport } from '../transport';

const SPECIAL_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

export function installHistoryHook(transport: Transport): void {
  const send = (e: AgentEvent) => transport.send(e);

  document.addEventListener(
    'click',
    (ev) => {
      const el = ev.target instanceof Element ? ev.target : null;
      if (!el) return;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      send({ type: 'interaction.click', ts: Date.now(), selector: selectorOf(el), tag: el.tagName.toLowerCase(), ...(text ? { text } : {}), x: ev.clientX, y: ev.clientY, button: ev.button });
    },
    true,
  );

  // Inputs: debounce per element so typing becomes one event per pause, plus one on change.
  const timers = new WeakMap<Element, number>();
  const reportInput = (el: Element, inputType?: string) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const raw = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : el.value;
    send({
      type: 'interaction.input',
      ts: Date.now(),
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      ...(inputType ? { inputType } : {}),
      value: raw.slice(0, 200),
    });
  };
  document.addEventListener(
    'input',
    (ev) => {
      const el = ev.target instanceof Element ? ev.target : null;
      if (!el) return;
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(el, window.setTimeout(() => reportInput(el, (ev as InputEvent).inputType), 500));
    },
    true,
  );
  document.addEventListener(
    'change',
    (ev) => {
      const el = ev.target instanceof Element ? ev.target : null;
      if (!el) return;
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      reportInput(el, 'change');
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (ev) => {
      if (!SPECIAL_KEYS.has(ev.key)) return;
      const el = ev.target instanceof Element ? ev.target : document.body;
      send({ type: 'interaction.key', ts: Date.now(), key: ev.key, selector: selectorOf(el) });
    },
    true,
  );

  let scrollTimer: number | null = null;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollTimer !== null) return;
      scrollTimer = window.setTimeout(() => {
        scrollTimer = null;
        send({ type: 'interaction.scroll', ts: Date.now(), x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
      }, 250);
    },
    { passive: true },
  );

  document.addEventListener(
    'submit',
    (ev) => {
      const form = ev.target instanceof HTMLFormElement ? ev.target : null;
      if (!form) return;
      send({ type: 'interaction.submit', ts: Date.now(), selector: selectorOf(form), ...(form.action ? { action: form.action } : {}), method: form.method || 'get' });
    },
    true,
  );

  // Title changes (SPAs set document.title on route changes).
  let lastTitle = document.title;
  const titleEl = document.querySelector('title') ?? document.head;
  if (titleEl) {
    new MutationObserver(() => {
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        send({ type: 'page.title', ts: Date.now(), title: lastTitle });
      }
    }).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // DOM activity: count mutations in ~500ms buckets so the History tab can draw a density lane
  // without us streaming the DOM itself (that is the Screen/time-travel path).
  let mutations = 0;
  let added = 0;
  let removed = 0;
  let domTimer: number | null = null;
  const flushDom = () => {
    domTimer = null;
    if (mutations === 0) return;
    send({ type: 'dom.activity', ts: Date.now(), mutations, added, removed });
    mutations = added = removed = 0;
  };
  new MutationObserver((records) => {
    for (const r of records) {
      mutations++;
      added += r.addedNodes.length;
      removed += r.removedNodes.length;
    }
    if (domTimer === null) domTimer = window.setTimeout(flushDom, 500);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

  // Light performance observations.
  if (typeof PerformanceObserver !== 'undefined') {
    const origin = performance.timeOrigin;
    const observe = (type: string, cb: (entries: PerformanceEntryList) => void) => {
      try {
        const po = new PerformanceObserver((list) => cb(list.getEntries()));
        po.observe({ type, buffered: true });
      } catch {
        /* unsupported entry type */
      }
    };
    observe('longtask', (entries) => {
      for (const e of entries) send({ type: 'perf.longtask', ts: Math.round(origin + e.startTime), durationMs: Math.round(e.duration) });
    });
    observe('layout-shift', (entries) => {
      for (const e of entries as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (e.value >= 0.01) send({ type: 'perf.layoutShift', ts: Math.round(origin + e.startTime), value: Math.round(e.value * 1000) / 1000, hadRecentInput: e.hadRecentInput });
      }
    });
    observe('paint', (entries) => {
      for (const e of entries) send({ type: 'perf.paint', ts: Math.round(origin + e.startTime), name: e.name, startTime: Math.round(e.startTime) });
    });
    observe('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1];
      if (last) send({ type: 'perf.paint', ts: Math.round(origin + last.startTime), name: 'largest-contentful-paint', startTime: Math.round(last.startTime) });
    });
  }
}

/** App annotation API: window[mark].mark('checkout:start', { cart }) */
export function mark(transport: Transport, name: string, data?: unknown): void {
  transport.send({ type: 'mark.custom', ts: Date.now(), name: String(name).slice(0, 120), ...(data !== undefined ? { data: serialize(data) } : {}) });
}

/** Short, stable-ish selector: tag#id or tag.class:nth-of-type, up to three levels. */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el, depth = 0; e && depth < 3 && e !== document.documentElement; e = e.parentElement, depth++) {
    if (e.id) {
      parts.unshift(`#${e.id}`);
      break;
    }
    let part = e.tagName.toLowerCase();
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter((c) => c && !/^(active|hover|focus)/.test(c)).slice(0, 2) : [];
    if (cls.length) part += '.' + cls.join('.');
    const parent = e.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === e!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
    }
    parts.unshift(part);
  }
  return parts.join(' > ');
}
