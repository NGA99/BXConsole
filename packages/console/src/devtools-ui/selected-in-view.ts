/**
 * Keep the selected tab where it can be seen.
 *
 * Both strips in this window scroll sideways when they do not fit — the
 * panels across the top, and the windows of a session above them — and
 * neither of them moved when the selection changed. Docked at 560px the
 * selected panel sat past the right edge, so the bar showed five tabs with
 * none of them marked and the one you were looking at was the one you could
 * not see. The strip does it to itself as well: it picks the window that is
 * still connected when the stored one has gone, and that window may be the
 * last of eight.
 *
 * Both mark the selection with `aria-selected`, so that is what this looks
 * for rather than a class either of them happens to use.
 *
 * It hands back a ref callback rather than taking a ref object, because the
 * window strip renders nothing until it has two windows to show: with a ref
 * object the effect ran once against a bar that did not exist yet, and the
 * selection had not changed by the time one did, so it never ran again.
 */
import { useEffect, useState } from 'react';

export function useSelectedInView(selected: string | null): (el: HTMLElement | null) => void {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!bar) return;
    /*
     * The scroll is worked out here rather than left to scrollIntoView,
     * which also walks up and scrolls whatever ancestors it likes. This bar
     * is the only thing that should move, and the arithmetic says plainly
     * what "in view" means: nothing moves when it already is.
     *
     * Measured against the bar itself rather than through offsetLeft, which
     * is relative to whichever ancestor happens to be positioned — not this
     * one, so the first version of this scrolled to a number that meant
     * nothing here and left the selected tab where it was.
     */
    const show = () => {
      const tab = bar.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!tab) return;
      const within = bar.getBoundingClientRect();
      const at = tab.getBoundingClientRect();
      const off = at.left < within.left ? at.left - within.left : at.right > within.right ? at.right - within.right : 0;
      if (off) bar.scrollLeft += off;
    };
    show();
    /*
     * And again whenever the bar's width changes, because the first call is
     * often too early to matter: at the moment a panel mounts the bar is
     * still as wide as the window and has nothing to scroll, and it only
     * overflows once the dock has sized itself. The same observer covers the
     * other way in, which is somebody dragging the splitter until the
     * selected tab falls off the end.
     */
    const watch = new ResizeObserver(show);
    watch.observe(bar);
    return () => watch.disconnect();
  }, [bar, selected]);
  return setBar;
}
