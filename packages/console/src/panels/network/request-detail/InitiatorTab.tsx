/** What made the request: the page's own call stack, where there is one. */
import type { NetworkEntry } from '../../../state/session-data';
import { StackTrace } from '../../console/StackTrace';
import { Section, Empty } from './bits';

export function InitiatorTab({ entry }: { entry: NetworkEntry }) {
  if (entry.request.stack) {
    return (
      <div className="detail-sections">
        <Section title="Request call stack">
          <div className="mono">
            <StackTrace stack={entry.request.stack} />
          </div>
        </Section>
      </div>
    );
  }
  return (
    <Empty>
      {entry.resource
        ? `Initiated by the ${entry.resource.initiatorType === 'navigation' ? 'navigation' : `HTML parser (${entry.resource.initiatorType})`}; no script stack for resources observed via PerformanceObserver.`
        : 'No initiator information.'}
    </Empty>
  );
}
