import test from 'node:test';
import assert from 'node:assert/strict';
import { placePopover } from '../src/components/motion/popover-position.ts';

test('a wide context panel stays inside a narrow viewport', () => {
  const layout = { viewport: { width: 390, height: 844 }, trigger: { left: 225, top: 783, width: 32, height: 32 }, content: { width: 360, height: 496 } };
  const p = placePopover(layout, 'top', 'end');
  assert.ok(p.left >= 12 && p.left + layout.content.width <= 378);
  assert.ok(p.top >= 12 && p.top + layout.content.height <= 832);
  assert.equal(p.side, 'top');
});

test('a panel flips away from an edge when the other side has room', () => {
  const layout = { viewport: { width: 800, height: 600 }, trigger: { left: 760, top: 30, width: 32, height: 32 }, content: { width: 290, height: 230 } };
  const p = placePopover(layout, 'top', 'start');
  assert.equal(p.side, 'bottom');
  assert.equal(p.top, 70);
  assert.ok(p.left + 290 <= 788);
});

test('oversized content is positioned using its viewport constrained size', () => {
  const p = placePopover({ viewport: { width: 320, height: 400 }, trigger: { left: 20, top: 200, width: 32, height: 32 }, content: { width: 500, height: 600 } }, 'bottom', 'end');
  assert.equal(p.left, 12);
  assert.equal(p.top, 12);
});
