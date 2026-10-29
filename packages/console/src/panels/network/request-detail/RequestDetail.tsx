/**
 * The drawer that opens when a row is selected:
 * Headers · Payload · Messages · Preview · Response · Initiator · Timing
 *
 * Each tab is a file beside this one. They were all in here, six hundred
 * lines of them, which is also where a `RunEnded` notice sat that nothing had
 * rendered since the re-read path was rewritten.
 */
import { useState } from 'react';
import type { NetworkEntry } from '../../../state/session-data';
import { streamsFrames } from '../classify';
import { TabBar } from '../../../devtools-ui/TabBar';
import { HeadersTab } from './HeadersTab';
import { PayloadTab } from './PayloadTab';
import { PreviewTab } from './PreviewTab';
import { ResponseTab } from './ResponseTab';
import { InitiatorTab } from './InitiatorTab';
import { MessagesTab } from './MessagesTab';
import { TimingTab } from './TimingTab';

type TabId = 'headers' | 'payload' | 'preview' | 'response' | 'initiator' | 'timing' | 'messages';

export function RequestDetail({ entry, sessionId, onClose }: { entry: NetworkEntry; sessionId: string; onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('headers');
  const hasPayload = Boolean(entry.request.body) || new URL(entry.request.url, 'http://x').search.length > 1;

  // Both kinds that stay open show the Frames tab and no response body.
  const isWs = streamsFrames(entry);
  const tabs = [
    { id: 'headers' as const, label: 'Headers' },
    { id: 'payload' as const, label: 'Payload', disabled: !hasPayload },
    ...(isWs ? [{ id: 'messages' as const, label: 'Messages' }] : []),
    { id: 'preview' as const, label: 'Preview', disabled: isWs },
    { id: 'response' as const, label: 'Response', disabled: isWs },
    { id: 'initiator' as const, label: 'Initiator' },
    { id: 'timing' as const, label: 'Timing' },
  ];

  /*
   * The selection follows the reader from row to row, which is what you want
   * for Headers or Timing and impossible for the rest: Messages is not there
   * at all on a row that does not stream, and Preview and Response are
   * disabled on a row that does. Left as it was, picking Messages on a socket
   * and then clicking a fetch row showed an empty "0 messages" table under a
   * tab strip with nothing selected in it.
   */
  const available = new Set(tabs.filter((t) => !('disabled' in t && t.disabled)).map((t) => t.id));
  const active: TabId = available.has(tab) ? tab : 'headers';

  return (
    <div className="request-detail">
      <TabBar
        tabs={tabs}
        active={active}
        onSelect={setTab}
        trailing={
          <button className="toolbar-button request-detail-close" title="Close" onClick={onClose}>
            ✕
          </button>
        }
      />
      <div className="request-detail-body">
        {active === 'headers' && <HeadersTab entry={entry} />}
        {active === 'payload' && <PayloadTab entry={entry} sessionId={sessionId} />}
        {active === 'preview' && <PreviewTab entry={entry} sessionId={sessionId} />}
        {active === 'response' && <ResponseTab entry={entry} sessionId={sessionId} />}
        {active === 'initiator' && <InitiatorTab entry={entry} />}
        {active === 'timing' && <TimingTab entry={entry} />}
        {active === 'messages' && <MessagesTab entry={entry} />}
      </div>
    </div>
  );
}
