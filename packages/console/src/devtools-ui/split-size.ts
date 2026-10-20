/**
 * Where a split's divider is allowed to sit.
 *
 * Kept apart from the component so it can be tested: this has broken in both
 * directions before, and neither failure was visible in a screenshot until
 * someone had already lost a pane.
 */

/**
 * A side size this container can actually hold.
 *
 * The main pane's minimum wins. Below `minMain + minSide` there is no size
 * that satisfies both, and the old rule — honour `minSide` whatever happens —
 * resolved that by letting the two panes add up to more than the box holding
 * them. Nested splits made it visible: a Network panel docked into a narrow
 * column laid its rows and its detail pane side by side at their minimums and
 * ran off the edge, with no scrollbar, because the overflow was in a flex row
 * that had already said it would never grow.
 *
 * So the side gives way instead. Cramped is a state the layout can show;
 * wider than its own container is not.
 *
 * Clamping upwards matters just as much: `initialSide` is worked out from the
 * window, a window that is not laid out yet gives zero, and a side pane stuck
 * at zero has no handle wide enough to grab and nothing on screen to bring it
 * back. A reload used to be the only way out.
 */
export function clampSide(wanted: number, total: number, minMain: number, minSide: number): number {
  const upper = Math.max(0, total - minMain);
  const lower = Math.min(minSide, upper);
  return Math.min(upper, Math.max(lower, wanted));
}

/**
 * How big the sized pane is partway through a drag.
 *
 * The sign depends on which end that pane sits at, and it is the sort of
 * thing that is wrong in exactly one of the two cases and looks fine in
 * testing because only one case was tried. Dragging away from the pane makes
 * it bigger: to the right when it is on the left, to the left when it is on
 * the right.
 *
 * `delta` is how far the pointer has moved along the axis since the drag
 * began, positive meaning right or down.
 */
export function sizeAfterDrag(startSize: number, delta: number, sideOn: 'start' | 'end'): number {
  return sideOn === 'start' ? startSize + delta : startSize - delta;
}
