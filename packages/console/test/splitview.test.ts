/**
 * The divider position, which has broken in both directions before.
 *
 * Once a side pane that started at zero could never be dragged back, because
 * the clamp only ever shrank. Then the opposite: a split narrower than its
 * two minimums honoured both and overflowed its own container, which in a
 * flex row that has said it will never grow means content simply off the edge
 * with no scrollbar to find it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSide, sizeAfterDrag } from '../src/devtools-ui/split-size';

const MIN_MAIN = 120;
const MIN_SIDE = 320;
const clamp = (wanted: number, total: number) => clampSide(wanted, total, MIN_MAIN, MIN_SIDE);

describe('with room for both panes', () => {
  test('a size that fits is left alone', () => {
    assert.equal(clamp(420, 1440), 420);
    assert.equal(clamp(MIN_SIDE, 1440), MIN_SIDE);
  });

  test('a side too small is raised, not left where it is', () => {
    // The bug that made a collapsed pane unrecoverable: nothing on screen to
    // grab, and a clamp that only ever went down.
    assert.equal(clamp(0, 1440), MIN_SIDE);
    assert.equal(clamp(1, 1440), MIN_SIDE);
    assert.equal(clamp(-50, 1440), MIN_SIDE);
  });

  test('a side too large is cut back so the main pane keeps its minimum', () => {
    assert.equal(clamp(5000, 1440), 1440 - MIN_MAIN);
    assert.equal(clamp(1440, 1440), 1440 - MIN_MAIN);
  });
});

describe('when the two minimums do not both fit', () => {
  const tight = MIN_MAIN + MIN_SIDE - 1;

  test('the pair never adds up to more than the container', () => {
    for (const total of [0, 1, 60, 119, 120, 200, 319, 320, tight, MIN_MAIN + MIN_SIDE]) {
      const side = clamp(MIN_SIDE, total);
      assert.ok(side >= 0, `negative side at ${total}`);
      assert.ok(side + MIN_MAIN <= Math.max(total, MIN_MAIN), `side ${side} + main ${MIN_MAIN} overflows ${total}`);
    }
  });

  test('the side gives way rather than the container', () => {
    assert.equal(clamp(MIN_SIDE, 320), 200, 'the side should shrink under its own minimum here');
    assert.equal(clamp(MIN_SIDE, tight), tight - MIN_MAIN);
  });

  test('a container too small for even the main pane leaves no side at all', () => {
    assert.equal(clamp(MIN_SIDE, 100), 0);
    assert.equal(clamp(MIN_SIDE, 0), 0);
  });

  test('growing the container again restores the side to its minimum', () => {
    // The sequence that produced the bug: squeezed narrow, then widened.
    const squeezed = clamp(420, 320);
    assert.ok(squeezed < MIN_SIDE);
    assert.equal(clamp(squeezed, 1440), MIN_SIDE, 'a widened window should give the side its minimum back');
  });
});

describe('a vertical split uses the same arithmetic', () => {
  test('heights behave like widths', () => {
    assert.equal(clampSide(500, 800, 100, 150), 500);
    assert.equal(clampSide(50, 800, 100, 150), 150);
    assert.equal(clampSide(900, 800, 100, 150), 700);
    assert.equal(clampSide(150, 200, 100, 150), 100);
  });
});

describe('which end the sized pane sits at', () => {
  /*
   * Sources puts its file tree on the left and the tree is what keeps its
   * width, so the sized pane is not always the right-hand one. The arithmetic
   * is the same; only the sign of the drag changes, and a sign that is right
   * at one end and wrong at the other looks correct until someone drags the
   * other one.
   */
  test('dragging away from the pane makes it bigger, at either end', () => {
    // On the right: the pointer going left (negative) grows it.
    assert.equal(sizeAfterDrag(300, -40, 'end'), 340);
    assert.equal(sizeAfterDrag(300, 40, 'end'), 260);
    // On the left: the other way round.
    assert.equal(sizeAfterDrag(300, 40, 'start'), 340);
    assert.equal(sizeAfterDrag(300, -40, 'start'), 260);
  });

  test('a drag that went nowhere changes nothing', () => {
    assert.equal(sizeAfterDrag(230, 0, 'start'), 230);
    assert.equal(sizeAfterDrag(230, 0, 'end'), 230);
  });

  test('the two ends are mirror images, which is the whole claim', () => {
    for (const delta of [-500, -1, 0, 1, 37, 500]) {
      assert.equal(sizeAfterDrag(400, delta, 'start') + sizeAfterDrag(400, delta, 'end'), 800, `delta ${delta}`);
    }
  });

  test('the clamp still has the last word', () => {
    // Dragging past the far edge cannot push the pane out of its bounds.
    assert.equal(clamp(sizeAfterDrag(300, 5000, 'start'), 1000), 1000 - MIN_MAIN);
    assert.equal(clamp(sizeAfterDrag(300, -5000, 'start'), 1000), MIN_SIDE);
  });
});
