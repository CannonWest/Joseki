import test from 'node:test';
import assert from 'node:assert/strict';
import { clampOffset, KEEP_VISIBLE, NO_OFFSET } from '../src/hooks/usePointerDrag';

/** A gate panel where one actually sits: 448px wide, near the top right. */
const frame = {
  panel: { left: 800, top: 16, width: 448 },
  viewport: { width: 1280, height: 720 }
};

test('a panel moves freely while it stays on screen', () => {
  assert.deepEqual(clampOffset({ x: -300, y: 200 }, frame), { x: -300, y: 200 });
  assert.deepEqual(clampOffset(NO_OFFSET, frame), NO_OFFSET);
});

test('a panel dragged off the left keeps a grabbable strip on screen', () => {
  // Far enough left that only KEEP_VISIBLE of its right edge remains.
  const { x } = clampOffset({ x: -5000, y: 0 }, frame);
  assert.equal(x, KEEP_VISIBLE - 800 - 448);
  assert.equal(frame.panel.left + x + frame.panel.width, KEEP_VISIBLE, 'that strip is still in the window');
});

test('a panel dragged off the right keeps a grabbable strip on screen', () => {
  const { x } = clampOffset({ x: 5000, y: 0 }, frame);
  assert.equal(frame.panel.left + x, frame.viewport.width - KEEP_VISIBLE);
});

test('a panel cannot be pushed above the window, where its handle would be', () => {
  // The header is the only way to move it, so letting it go above the top
  // would strand it. It stops at the top edge.
  const { y } = clampOffset({ y: -5000, x: 0 }, frame);
  assert.equal(frame.panel.top + y, 0);
});

test('a panel dragged below keeps its header on screen', () => {
  const { y } = clampOffset({ y: 5000, x: 0 }, frame);
  assert.equal(frame.panel.top + y, frame.viewport.height - KEEP_VISIBLE);
});

test('a window that shrank pulls a pushed-aside panel back into view', () => {
  // The offset was fine on a wide window; re-clamping against a narrow one is
  // what keeps it reachable after a resize.
  const wasFine = { x: 300, y: 0 };
  assert.deepEqual(clampOffset(wasFine, frame), wasFine);

  const narrow = { ...frame, viewport: { width: 900, height: 720 } };
  assert.equal(clampOffset(wasFine, narrow).x, 900 - 800 - KEEP_VISIBLE);
});
