import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeUnder, type Box } from '../src/devtools-ui/in-viewport';

const button = (o: Partial<Box> = {}): Box => ({ top: 100, bottom: 126, left: 200, right: 226, ...o });
const screen = { width: 1024, height: 768 };

test('a left-aligned popup starts at the button', () => {
  assert.deepEqual(placeUnder(button(), { width: 160, height: 100 }, screen), { top: 128, left: 200 });
});

test('a right-aligned popup ends at the button, growing back towards the middle', () => {
  // The console settings gear, at the right of its toolbar: 248 wide hanging
  // back from a button ending at 826 starts at 578, not at the button's left.
  const at = placeUnder(button({ left: 800, right: 826 }), { width: 248, height: 137 }, screen, 'right');
  assert.deepEqual(at, { top: 128, left: 578 });
});

test('a popup that would hang off the right edge is pulled back inside', () => {
  const at = placeUnder(button({ left: 980, right: 1006 }), { width: 248, height: 100 }, screen);
  assert.equal(at.left, 1024 - 248 - 4);
});

test('a popup that would hang off the left edge is pushed back inside', () => {
  const at = placeUnder(button({ left: 10, right: 36 }), { width: 248, height: 100 }, screen, 'right');
  assert.equal(at.left, 4);
});

test('a popup wider than the window starts at the left edge', () => {
  const at = placeUnder(button(), { width: 2000, height: 100 }, screen);
  assert.equal(at.left, 4);
});

test('a popup with no room below opens above the button instead', () => {
  const at = placeUnder(button({ top: 700, bottom: 726 }), { width: 160, height: 200 }, screen);
  assert.equal(at.top, 700 - 2 - 200);
});

test('a popup with room for neither stays below, where it can be scrolled to', () => {
  // Pinning it to the top would lay it over its own button.
  const at = placeUnder(button({ top: 700, bottom: 726 }), { width: 160, height: 760 }, screen);
  assert.equal(at.top, 728);
});
