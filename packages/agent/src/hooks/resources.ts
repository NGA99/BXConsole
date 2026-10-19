/**
 * PerformanceObserver('resource') -> network.resource.
 *
 * Covers what fetch/XHR patching cannot see: <img>, <script>, <link>, fonts,
 * iframes. Only timing/size metadata is available here, no headers or
 * bodies. Entries for requests already reported by the fetch/XHR hook are
 * still emitted; the console dedupes by URL + startTime.
 */
import type { ResourceEntry } from '@bxconsole/protocol';
import type { Transport } from '../transport';

export function installResourceHook(transport: Transport): void {
  if (typeof PerformanceObserver === 'undefined') return;

  const report = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const r = e as PerformanceResourceTiming & { responseStatus?: number };
      if (r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest') continue;
      const entry: ResourceEntry = {
        name: r.name,
        initiatorType: r.initiatorType,
        startTime: r.startTime,
        duration: r.duration,
        startedAt: performance.timeOrigin + r.startTime,
        timing: {
          fetchStart: r.fetchStart,
          domainLookupStart: r.domainLookupStart,
          domainLookupEnd: r.domainLookupEnd,
          connectStart: r.connectStart,
          secureConnectionStart: r.secureConnectionStart,
          connectEnd: r.connectEnd,
          requestStart: r.requestStart,
          responseStart: r.responseStart,
          responseEnd: r.responseEnd,
        },
        transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize,
        decodedBodySize: r.decodedBodySize,
        ...(r.responseStatus !== undefined ? { responseStatus: r.responseStatus } : {}),
      };
      transport.send({ type: 'network.resource', ts: Date.now(), entry });
    }
  };

  // Entries that landed before we started observing.
  report(performance.getEntriesByType('resource'));

  const observer = new PerformanceObserver((list) => report(list.getEntries()));
  observer.observe({ type: 'resource', buffered: false });

  // Resource Timing hides status for cross-origin files, but a load failure
  // still surfaces as an `error` event on the element (capture phase only).
  window.addEventListener(
    'error',
    (ev) => {
      const t = ev.target;
      if (!(t instanceof Element) || t === (window as unknown as Element)) return;
      const url = (t as HTMLImageElement).currentSrc || (t as HTMLScriptElement).src || (t as HTMLLinkElement).href;
      if (!url) return;
      transport.send({ type: 'network.resourceFailed', ts: Date.now(), url, tag: t.tagName.toLowerCase() });
    },
    true,
  );
}
