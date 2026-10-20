/** Resource-type icons for the Name column, in the spirit of DevTools' small glyphs. */
import type { ResourceType } from './classify';

export function TypeIcon({ type, failed }: { type: ResourceType; failed?: boolean }) {
  if (failed) {
    return (
      <svg className="type-icon error" width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#fff" strokeWidth="1.4" />
      </svg>
    );
  }
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
