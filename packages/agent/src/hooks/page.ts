/**
 * Page lifecycle -> page.* events. Keeps the Sessions tab row fresh when the
 * SPA changes route or the tab goes to the background.
 */
import type { Transport } from '../transport';

export function installPageHook(transport: Transport): void {
  let lastUrl = location.href;

  // The first event of every document, which is why this hook is installed
  // before the one that flushes Resource Timing: the console clears the
  // window's log on it, like DevTools does on reload.
  transport.send({ type: 'page.navigated', ts: Date.now(), url: location.href, title: document.title, kind: 'load' });

  const reportNavigation = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    transport.send({ type: 'page.navigated', ts: Date.now(), url: location.href, title: document.title, kind: 'history' });
  };

  // SPA routers call pushState/replaceState; there is no event for those.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      queueMicrotask(reportNavigation);
      return result;
    };
  }
  window.addEventListener('popstate', reportNavigation);
  window.addEventListener('hashchange', reportNavigation);

  document.addEventListener('visibilitychange', () => {
    transport.send({ type: 'page.visibility', ts: Date.now(), hidden: document.hidden });
  });

  // Document milestones for the Network overview markers and status bar.
  const timing = () => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const origin = performance.timeOrigin;
    const dcl = nav?.domContentLoadedEventEnd ? origin + nav.domContentLoadedEventEnd : undefined;
    const load = nav?.loadEventEnd ? origin + nav.loadEventEnd : undefined;
    transport.send({ type: 'page.timing', ts: Date.now(), navigationStart: origin, ...(dcl ? { domContentLoaded: dcl } : {}), ...(load ? { load } : {}) });
  };
  if (document.readyState === 'complete') setTimeout(timing, 0);
  else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(timing, 0));
    window.addEventListener('load', () => setTimeout(timing, 0));
  }
}
