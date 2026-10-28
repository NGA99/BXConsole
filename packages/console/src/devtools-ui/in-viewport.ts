/**
 * Keeping a popup that hangs from a button both visible and inside the window.
 *
 * These popups live in a toolbar, and a toolbar scrolls: `.toolbar` carries
 * `overflow-x: auto` so that a dock narrower than its controls can still
 * reach the ones past the edge. Overflow clips in both directions whatever
 * the author asked for — a box with `overflow-x: auto` has no way to let its
 * children out vertically — so a menu positioned inside one is cut to the
 * toolbar's own 26px. The Console settings menu was 248×137 and nothing of
 * it could be seen; the level menu was the same, and so is anything else
 * that opens from a toolbar.
 *
 * So they are taken out of the flow entirely — `position: fixed`, placed from
 * the button's own rectangle — which no ancestor can clip. The placement is
 * also what keeps them inside the window, which this file did before by
 * nudging the margin: the level menu used to open 59px past the edge of a
 * 1024px window with its own checkmarks off-screen.
 */
import { useLayoutEffect, type RefObject } from 'react';

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Placement {
  top: number;
  left: number;
}

/** Breathing room kept between a popup and the edge of the window. */
const MARGIN = 4;
/** Between the button and the popup hanging off it. */
const GAP = 2;

/**
 * Where a popup hanging from a button belongs, in viewport coordinates.
 *
 * @param align  which edge of the popup lines up with the button's. A menu
 *               under a control at the right of a toolbar opens `right`, so
 *               it grows back towards the middle instead of off the edge.
 */
export function placeUnder(
  button: Box,
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'left' | 'right' = 'left',
): Placement {
  const wanted = align === 'right' ? button.right - popup.width : button.left;
  // Clamped against the right edge first and the left second, so a popup
  // wider than the window starts at the left edge rather than off it.
  const left = Math.max(MARGIN, Math.min(wanted, viewport.width - popup.width - MARGIN));

  const below = button.bottom + GAP;
  const above = button.top - GAP - popup.height;
  // Above the button only when there is no room below it and there is room
  // above: a menu pinned to the top of the window, overlapping its own
  // button, is worse than one whose last item needs a scroll.
  const top = below + popup.height > viewport.height - MARGIN && above >= MARGIN ? above : below;
  return { top, left };
}

/**
 * Place `popup` under `button` while `open`, out of reach of any ancestor's
 * overflow. The popup must be `position: fixed` in CSS; this sets where.
 */
export function useAnchoredPopup(
  button: RefObject<HTMLElement | null>,
  popup: RefObject<HTMLElement | null>,
  open: boolean,
  align: 'left' | 'right' = 'left',
): void {
  useLayoutEffect(() => {
    const b = button.current;
    const p = popup.current;
    if (!open || !b || !p) return;
    const place = () => {
      const { width, height } = p.getBoundingClientRect();
      const at = placeUnder(b.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight }, align);
      p.style.top = `${at.top}px`;
      p.style.left = `${at.left}px`;
    };
    place();
    /*
     * A fixed popup does not follow its button, and the button moves: the
     * dock splitter drags, the window resizes, and the toolbar it sits in
     * scrolls when the dock is narrow. Re-placing is cheaper than closing,
     * and closing on a drag would make the splitter unusable with a menu up.
     */
    window.addEventListener('resize', place);
    const toolbar = b.closest('.toolbar');
    toolbar?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      toolbar?.removeEventListener('scroll', place);
    };
  }, [button, popup, open, align]);
}
