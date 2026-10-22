/**
 * Keeping a popup that hangs from a button inside the window.
 *
 * Both of these open at `left: 0` under something near the right-hand edge
 * of a narrow dock — the session picker at the end of the path row, the
 * level menu at the end of the console toolbar — and the page itself does
 * not scroll, so whatever goes past the edge cannot be reached at all. The
 * level menu opened 59px past the edge of a 1024px window with its own
 * checkmarks off-screen.
 *
 * Shared because this is the third of these: the context menu grew its own
 * "keep inside the viewport" effect first, and a second copy went into the
 * session picker before anybody noticed the third popup needed one too.
 */
import { useLayoutEffect, type RefObject } from 'react';

export function useKeepInViewport(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    // Measured with the shift cleared, so reopening does not add to the last
    // one, and nudged by exactly what hangs over.
    el.style.marginLeft = '0px';
    const over = el.getBoundingClientRect().right - (window.innerWidth - 4);
    if (over > 0) el.style.marginLeft = `${-over}px`;
  }, [ref, open]);
}
