/** Shared toolbar icons. The gear is Material Design's "settings" glyph, as in Chrome. */

export function GearIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className={`toolbar-icon${active ? ' active' : ''}`} fill="currentColor">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  );
}

/**
 * Row and player icons, drawn on a 24×24 grid like the gear above so they line
 * up at any size. `size` is in CSS pixels; the defaults are what the History
 * rows and the Screen player use.
 */
interface IconProps {
  size?: number;
}

/** Rewind to a moment: a clock hand swept backwards. "Show the screen at this time". */
export function RewindToIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 9.5a9 9 0 1 1-.4 5.2" />
      <path d="M3 4.5v5h5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

/** Reveal the same thing in another panel: an arrow leaving a frame. */
export function RevealIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="M19.5 4.5L12 12" />
      <path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
    </svg>
  );
}

export function PlayIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5l13 7.5-13 7.5z" />
    </svg>
  );
}

export function PauseIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" />
    </svg>
  );
}

/** One batch back / forward: the step glyphs of a media player. */
export function StepIcon({ size = 14, dir = 1 }: IconProps & { dir?: 1 | -1 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={dir === -1 ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M5 4.5l11 7.5-11 7.5z" />
      <path d="M17.5 4.5h3v15h-3z" />
    </svg>
  );
}

/** Take a fresh snapshot / reload this frame. */
export function RefreshIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 3.5v5h-5" />
    </svg>
  );
}

/** Collapse the Screen pane to the left edge. */
/** The right-hand pane shaded: pressing it folds that pane away to the right. */
export function CollapseRightPaneIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
      <path d="M13.5 4.5v15" fill="currentColor" />
      <path d="M13.5 4.5H21v15h-7.5z" fill="currentColor" stroke="none" opacity="0.35" />
    </svg>
  );
}

export function CollapsePaneIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
      <path d="M10.5 4.5v15" fill="currentColor" />
      <path d="M3 4.5h7.5v15H3z" fill="currentColor" stroke="none" opacity="0.35" />
    </svg>
  );
}

/*
 * The three severities, drawn once.
 *
 * The error circle was drawn in three places — the Console's rows, the title
 * bar's counters, and the Network list's Name column for a request that
 * failed — each one its own `<svg>` with the same two paths in it, and the
 * warning triangle in two. Nothing kept them the same shape; they happened to
 * be, which is not a property you can rely on when one of them is edited.
 *
 * They stay on their own 14×14 grid rather than the 24×24 one above, because
 * that is the grid they are drawn on and rescaling the paths to share a grid
 * would move pixels for nothing. `className` is the caller's: the colour
 * comes from the row, the badge or the cell these sit in.
 *
 * The ink on the filled glyph is literal black and white on purpose — it is
 * ink on red or yellow, not on the page, so it does not follow the theme.
 */
interface GlyphProps extends IconProps {
  className?: string;
}

export function ErrorIcon({ size = 14, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

export function WarnIcon({ size = 14, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={className} aria-hidden="true">
      <path d="M7 1.5L13 12.5H1z" fill="currentColor" />
      <path d="M7 5.5v3.5" stroke="#000" strokeWidth="1.4" />
      <circle cx="7" cy="10.8" r="0.8" fill="#000" />
    </svg>
  );
}

export function InfoIcon({ size = 14, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M7 6v4" stroke="#fff" strokeWidth="1.4" />
      <circle cx="7" cy="4" r="0.8" fill="#fff" />
    </svg>
  );
}

/**
 * Clear what is listed: DevTools' circle-with-a-slash.
 *
 * One copy. It was byte-for-byte the same function in ConsolePanel.tsx and in
 * NetworkPanel.tsx, which is the same button on two toolbars.
 */
export function ClearIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.2 3.2l7.6 7.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** Pick an element in the page: DevTools' cursor over a corner. */
export function InspectIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={`toolbar-icon${active ? ' active' : ''}`} aria-hidden="true">
      <path d="M2 2h7v1.5H3.5V9H2z M7 7l7 2.6-2.9 1.1L13 13.6 11.6 15l-2.9-2.9L7.6 15z" fill="currentColor" />
    </svg>
  );
}

/**
 * Stands in for a site's own icon when there is not one to show.
 *
 * A filled square was reading as a picture that failed to load rather than
 * as a picture nobody has — and a list of recordings is mostly rows that have
 * none, because the console will not call out to every origin it has ever
 * seen just to decorate a row.
 */
export function SiteIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z" />
    </svg>
  );
}
