import { describe, expect, it } from 'vitest';

import { MIN_ELEMENT_SIZE, ROTATION_SNAP_RADIANS } from '@/constants';
import {
  elementAABB,
  elementCenter,
  normalizeAngle,
  resizeElements,
  rotateElements,
  translateElements,
  unionBounds,
} from '@/features/elements/operations';
import {
  bringForward,
  bringToFront,
  moveToIndex,
  sendBackward,
  sendToBack,
} from '@/features/elements/zorder';
import type { CanvasElement, RectangleElement, Vec2 } from '@/types';

function rect(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0
): RectangleElement {
  return {
    id,
    type: 'rectangle',
    name: id,
    x,
    y,
    width,
    height,
    rotation,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    strokeStyle: 'solid',
    cornerRadius: 0,
  };
}

/** World position of a local corner, for asserting that a resize anchor held. */
function cornerWorld(element: CanvasElement, signX: number, signY: number): Vec2 {
  const center = elementCenter(element);
  const local = { x: (signX * element.width) / 2, y: (signY * element.height) / 2 };
  const cos = Math.cos(element.rotation);
  const sin = Math.sin(element.rotation);
  return {
    x: center.x + local.x * cos - local.y * sin,
    y: center.y + local.x * sin + local.y * cos,
  };
}

describe('elementAABB', () => {
  it('is the element box itself when unrotated', () => {
    expect(elementAABB(rect('a', 10, 20, 100, 50))).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('grows a rotated square to the box it actually covers', () => {
    // A 100x100 square at 45° spans 100·√2 ≈ 141.42 on both axes, centred at (50,50).
    const box = elementAABB(rect('a', 0, 0, 100, 100, Math.PI / 4));
    expect(box.width).toBeCloseTo(141.421, 3);
    expect(box.height).toBeCloseTo(141.421, 3);
    expect(box.x).toBeCloseTo(50 - 141.421 / 2, 3);
  });
});

describe('unionBounds', () => {
  it('spans every element', () => {
    expect(unionBounds([rect('a', 0, 0, 10, 10), rect('b', 90, 40, 10, 60)])).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it('is empty for an empty selection', () => {
    expect(unionBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('translateElements', () => {
  it('offsets every element by the world delta', () => {
    const patches = translateElements([rect('a', 10, 10, 5, 5), rect('b', -4, 2, 5, 5)], 3, -7);
    expect(patches['a']).toEqual({ x: 13, y: 3 });
    expect(patches['b']).toEqual({ x: -1, y: -5 });
  });
});

describe('resizeElements - single unrotated element', () => {
  const element = rect('a', 0, 0, 100, 50);
  const bounds = { x: 0, y: 0, width: 100, height: 50 };

  it('drags the SE corner and pins NW', () => {
    const patch = resizeElements([element], bounds, 'se', { x: 150, y: 100 })['a'];
    expect(patch).toEqual({ x: 0, y: 0, width: 150, height: 100 });
  });

  it('drags the NW corner and pins SE', () => {
    const patch = resizeElements([element], bounds, 'nw', { x: -50, y: -25 })['a'];
    expect(patch).toEqual({ x: -50, y: -25, width: 150, height: 75 });
  });

  it('leaves the cross axis alone for an edge handle', () => {
    const patch = resizeElements([element], bounds, 'e', { x: 200, y: 999 })['a'];
    expect(patch).toEqual({ x: 0, y: 0, width: 200, height: 50 });
  });

  it('clamps to MIN_ELEMENT_SIZE instead of flipping through the anchor', () => {
    const patch = resizeElements([element], bounds, 'se', { x: -400, y: -400 })['a'];
    expect(patch).toEqual({
      x: 0,
      y: 0,
      width: MIN_ELEMENT_SIZE,
      height: MIN_ELEMENT_SIZE,
    });
  });

  it('grows symmetrically about the centre when fromCenter is set', () => {
    const patch = resizeElements([element], bounds, 'e', { x: 150, y: 0 }, { fromCenter: true })[
      'a'
    ];
    // q.x = 150 - 50 = 100, doubled to a width of 200, centre stays at x = 50.
    expect(patch).toEqual({ x: -50, y: 0, width: 200, height: 50 });
  });

  it('locks the aspect ratio to the larger of the two implied scales', () => {
    const patch = resizeElements(
      [element],
      bounds,
      'se',
      { x: 200, y: 60 },
      { preserveAspect: true }
    )['a'];
    // scaleX = 2, scaleY = 1.2 → 2 wins; 100x50 becomes 200x100 anchored at NW.
    expect(patch).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it('keeps the ratio when the aspect-locked box hits the minimum', () => {
    const patch = resizeElements(
      [element],
      bounds,
      'se',
      { x: -999, y: -999 },
      { preserveAspect: true }
    )['a'];
    expect(patch?.width).toBeCloseTo(2 * MIN_ELEMENT_SIZE);
    expect(patch?.height).toBeCloseTo(MIN_ELEMENT_SIZE);
  });
});

describe('resizeElements - a rotated element', () => {
  // 100x100 square at (0,0) turned 90°. Its NW corner sits at world (100, 0);
  // its SE corner - the one being dragged - sits at world (0, 100).
  const element = rect('a', 0, 0, 100, 100, Math.PI / 2);
  const bounds = { x: 0, y: 0, width: 100, height: 100 };

  it('resizes along the element axes, not the world axes', () => {
    // A pointer at local (100,100) is world (-50,150) once rotated by 90°.
    const patch = resizeElements([element], bounds, 'se', { x: -50, y: 150 })['a'];
    expect(patch?.width).toBeCloseTo(150);
    expect(patch?.height).toBeCloseTo(150);
    expect(patch?.x).toBeCloseTo(-50);
    expect(patch?.y).toBeCloseTo(0);
    expect(patch).not.toHaveProperty('rotation');
  });

  it('keeps the corner opposite the handle pinned in world space', () => {
    const anchorBefore = cornerWorld(element, -1, -1);
    const patch = resizeElements([element], bounds, 'se', { x: -50, y: 150 })['a'];
    const resized: CanvasElement = { ...element, ...patch };
    const anchorAfter = cornerWorld(resized, -1, -1);

    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y);
  });
});

describe('resizeElements - a multi-selection', () => {
  it('scales each element proportionally inside the group box', () => {
    const elements = [rect('a', 0, 0, 10, 10), rect('b', 90, 90, 10, 10)];
    const patches = resizeElements(elements, { x: 0, y: 0, width: 100, height: 100 }, 'se', {
      x: 200,
      y: 200,
    });
    expect(patches['a']).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(patches['b']).toEqual({ x: 180, y: 180, width: 20, height: 20 });
  });
});

describe('rotateElements', () => {
  it('advances the angle and orbits the centre, so a group turns as one body', () => {
    const patch = rotateElements([rect('a', 0, 0, 100, 100)], { x: 0, y: 0 }, Math.PI / 2)['a'];
    expect(patch?.rotation).toBeCloseTo(Math.PI / 2);
    // Centre (50,50) orbits to (-50,50); the box origin follows to (-100, 0).
    expect(patch?.x).toBeCloseTo(-100);
    expect(patch?.y).toBeCloseTo(0);
  });

  it('leaves an element rotated about its own centre in place', () => {
    const element = rect('a', 0, 0, 100, 60);
    const patch = rotateElements([element], elementCenter(element), Math.PI / 3)['a'];
    expect(patch?.x).toBeCloseTo(0);
    expect(patch?.y).toBeCloseTo(0);
    expect(patch?.rotation).toBeCloseTo(Math.PI / 3);
  });

  it('snaps the delta, not each element’s absolute angle', () => {
    const splayed = [rect('a', 0, 0, 10, 10, 0.4), rect('b', 50, 0, 10, 10, 1.1)];
    const patches = rotateElements(splayed, { x: 0, y: 0 }, 0.3, true);
    const delta = ROTATION_SNAP_RADIANS; // round(0.3 / 0.2618) === 1
    expect(patches['a']?.rotation).toBeCloseTo(0.4 + delta);
    expect(patches['b']?.rotation).toBeCloseTo(1.1 + delta);
  });

  it('snaps a small nudge away to nothing', () => {
    const patch = rotateElements([rect('a', 0, 0, 10, 10)], { x: 0, y: 0 }, 0.05, true)['a'];
    expect(patch?.rotation).toBe(0);
  });
});

describe('normalizeAngle', () => {
  it('folds any angle into [0, 2π)', () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
  });
});

describe('z-order', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('brings one element forward by a single step', () => {
    expect(bringForward(order, ['b'])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves a contiguous run forward as a block', () => {
    expect(bringForward(order, ['a', 'b'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('sends one element backward by a single step', () => {
    expect(sendBackward(order, ['c'])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('brings a selection to the front, preserving its internal order', () => {
    expect(bringToFront(order, ['a', 'c'])).toEqual(['b', 'd', 'a', 'c']);
  });

  it('sends a selection to the back, preserving its internal order', () => {
    expect(sendToBack(order, ['b', 'd'])).toEqual(['b', 'd', 'a', 'c']);
  });

  it('reinserts one id at an arbitrary index', () => {
    expect(moveToIndex(order, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveToIndex(order, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('returns the same array reference when nothing moves', () => {
    // The identity is load-bearing: history treats it as a no-op and refuses
    // to record an undo step for "bring to front" on a top element.
    expect(bringForward(order, ['d'])).toBe(order);
    expect(sendBackward(order, ['a'])).toBe(order);
    expect(bringToFront(order, ['c', 'd'])).toBe(order);
    expect(sendToBack(order, ['a', 'b'])).toBe(order);
    expect(moveToIndex(order, 'a', 0)).toBe(order);
    expect(moveToIndex(order, 'missing', 2)).toBe(order);
  });
});

describe('autoHeight release on resize', () => {
  const text = (autoHeight: boolean): CanvasElement => ({
    id: 't',
    type: 'text',
    name: 'Text 1',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    text: 'hello',
    fontFamily: 'sans-serif',
    fontSize: 16,
    fontWeight: 400,
    italic: false,
    textAlign: 'left',
    lineHeight: 1.35,
    color: '#000',
    autoHeight,
  });

  const bounds = { x: 0, y: 0, width: 100, height: 40 };

  it('clears autoHeight when a height-changing handle is dragged', () => {
    // Without this the resize silently undoes itself: the height is patched,
    // the flag stays true, and the next keystroke recomputes from content.
    for (const handle of ['n', 's', 'ne', 'nw', 'se', 'sw'] as const) {
      const patch = resizeElements([text(true)], bounds, handle, { x: 120, y: 90 })['t'];
      expect(patch?.autoHeight).toBe(false);
    }
  });

  it('leaves autoHeight alone for width-only handles', () => {
    for (const handle of ['e', 'w'] as const) {
      const patch = resizeElements([text(true)], bounds, handle, { x: 120, y: 40 })['t'];
      expect(patch).not.toHaveProperty('autoHeight');
    }
  });

  it('does not touch elements that have no autoHeight', () => {
    const patch = resizeElements([rect('a', 0, 0, 10, 10)], bounds, 's', { x: 10, y: 90 })['a'];
    expect(patch).not.toHaveProperty('autoHeight');
  });
});
