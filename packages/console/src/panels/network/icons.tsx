/**
 * The Network panel's own glyphs: the resource-type icons for the Name
 * column, and the two toolbar buttons that open the filter and the search.
 *
 * They were in NetworkPanel.tsx, below eight hundred lines of panel, which
 * is where the third copy of the error circle was found.
 */
import type { ResourceType } from './classify';
import { ErrorIcon } from '../../devtools-ui/icons';

/** Opens the row filter: DevTools' funnel, filled while it is on. */
export function FunnelIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${active ? ' active' : ''}`} aria-hidden="true">
      <path
        d="M2 3h12l-4.6 5.6V13l-2.8 1.2V8.6z"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Opens the search that looks inside the requests, not at which are listed. */
export function SearchIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${active ? ' active' : ''}`} aria-hidden="true">
      <circle cx="6.8" cy="6.8" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.2 10.2L14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function TypeIcon({ type, failed }: { type: ResourceType; failed?: boolean }) {
  // A request that failed is the same error circle the Console's rows and the
  // title bar's counters draw; it wears this column's class to take its size
  // and colour from the cell.
  if (failed) return <ErrorIcon className="type-icon error" />;
  switch (type) {
    case 'doc':
      return (
        <svg className="type-icon doc" width="14" height="14" viewBox="0 0 14 14">
          <rect x="2.5" y="1.5" width="9" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4.5 5h5M4.5 7.5h5M4.5 10h3" stroke="currentColor" strokeWidth="1" />
        </svg>
      );
    case 'js':
      return (
        <svg className="type-icon js" width="14" height="14" viewBox="0 0 14 14">
          <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="currentColor" />
          <text x="7" y="10.5" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#fff" fontFamily="sans-serif">JS</text>
        </svg>
      );
    case 'css':
      return (
        <svg className="type-icon css" width="14" height="14" viewBox="0 0 14 14">
          <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="currentColor" />
          <text x="7" y="10" textAnchor="middle" fontSize="6.5" fontWeight="bold" fill="#fff" fontFamily="sans-serif">CSS</text>
        </svg>
      );
    case 'img':
      return (
        <svg className="type-icon img" width="14" height="14" viewBox="0 0 14 14">
          <rect x="1.5" y="2.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3 10l3-3.5 2 2 1.5-1.5L11 10z" fill="currentColor" />
          <circle cx="9.5" cy="5" r="1" fill="currentColor" />
        </svg>
      );
    case 'font':
      return (
        <svg className="type-icon font" width="14" height="14" viewBox="0 0 14 14">
          <text x="7" y="11" textAnchor="middle" fontSize="11" fontWeight="bold" fill="currentColor" fontFamily="serif">A</text>
        </svg>
      );
    case 'media':
      return (
        <svg className="type-icon media" width="14" height="14" viewBox="0 0 14 14">
          <path d="M3.5 2.5l8 4.5-8 4.5z" fill="currentColor" />
        </svg>
      );
    case 'ws':
      return (
        <svg className="type-icon ws" width="14" height="14" viewBox="0 0 14 14">
          <path d="M2 5h7l-2-2M12 9H5l2 2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    /*
     * One arrow to the websocket's two, because that is the difference that
     * matters about it: the server sends and the page only listens. Without
     * its own glyph it fell to the empty box every unknown type gets, which
     * made giving it a type of its own pointless in the one column a reader
     * actually scans.
     */
    case 'eventsource':
      return (
        <svg className="type-icon eventsource" width="14" height="14" viewBox="0 0 14 14">
          <path d="M11 7H3l2.5-2.5M3 7l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'fetch':
    case 'xhr':
      return (
        <svg className="type-icon fetch" width="14" height="14" viewBox="0 0 14 14">
          <path d="M5 3L2 7l3 4M9 3l3 4-3 4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    default:
      return (
        <svg className="type-icon other" width="14" height="14" viewBox="0 0 14 14">
          <rect x="2.5" y="1.5" width="9" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
  }
}
