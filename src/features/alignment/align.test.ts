import { describe, expect, it } from 'vitest';

import { alignElements, distributeElements } from '@/features/alignment/align';
import type { MoveTargets } from '@/features/alignment/align';
import { elementAABB } from '@/features/elements/operations';
import type { RectangleElement } from '@/types';

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

/**
 * a: 10x10 at (0, 0)      b: 20x20 at (50, 20)     c: 10x30 at (100, 50)
 * Group box: x 0..110 (width 110), y 0..80 (height 80).
 */
const A = rect('a', 0, 0, 10, 10);
const B = rect('b', 50, 20, 20, 20);
const C = rect('c', 100, 50, 10, 30);
const ALL = [A, B, C];

describe('alignElements', () => {
  it('aligns left edges to the group box', () => {
    const patches = alignElements(ALL, 'left');
    expect(patches['a']).toBeUndefined(); // already there - no patch, no churn
    expect(patches['b']).toEqual({ x: 0 });
    expect(patches['c']).toEqual({ x: 0 });
  });

  it('aligns right edges to the group box', () => {
    const patches = alignElements(ALL, 'right');
    expect(patches['a']).toEqual({ x: 100 });
    expect(patches['b']).toEqual({ x: 90 });
    expect(patches['c']).toBeUndefined();
  });

  it('centres horizontally on the group centre', () => {
    // Group centre x = 55.
    const patches = alignElements(ALL, 'center-x');
    expect(patches['a']).toEqual({ x: 50 });
    expect(patches['b']).toEqual({ x: 45 });
    expect(patches['c']).toEqual({ x: 50 });
  });

  it('aligns top edges', () => {
    const patches = alignElements(ALL, 'top');
    expect(patches['a']).toBeUndefined();
    expect(patches['b']).toEqual({ y: 0 });
    expect(patches['c']).toEqual({ y: 0 });
  });

  it('aligns bottom edges', () => {
    // Group bottom y = 80.
    const patches = alignElements(ALL, 'bottom');
    expect(patches['a']).toEqual({ y: 70 });
    expect(patches['b']).toEqual({ y: 60 });
    expect(patches['c']).toBeUndefined();
  });

  it('centres vertically on the group centre', () => {
    // Group centre y = 40.
    const patches = alignElements(ALL, 'center-y');
    expect(patches['a']).toEqual({ y: 35 });
    expect(patches['b']).toEqual({ y: 30 });
    expect(patches['c']).toEqual({ y: 25 });
  });

  it('aligns a rotated element by the box it visibly occupies', () => {
    // A 100x100 square at 45° covers x from -20.71 to 120.71 even though its
    // stored `x` is 0. Aligning it left against a neighbour at x = -100 must
    // move its *visible* edge there, not its unrotated origin - otherwise it
    // ends up hanging 20.71 units outside the group.
    const turned = rect('t', 0, 0, 100, 100, Math.PI / 4);
    const neighbour = rect('n', -100, 200, 10, 10);
    const patches = alignElements([neighbour, turned], 'left');

    const moved = { ...turned, ...patches['t'] };
    expect(elementAABB(moved).x).toBeCloseTo(-100, 6);
    // The stored origin moved by the same delta the AABB did, not to -100.
    expect(moved.x).toBeCloseTo(-100 + 20.7107, 3);
    expect(patches['n']).toBeUndefined();
  });

  it('is a no-op below two elements', () => {
    expect(alignElements([A], 'left')).toEqual({});
    expect(alignElements([], 'left')).toEqual({});
  });
});

describe('distributeElements', () => {
  it('evens out the gaps, leaving the outermost two where they are', () => {
    // span 110, sizes 10+20+10 = 40, so each of the two gaps is 35.
    // a at 0 → b at 45 → c at 100.
    const patches = distributeElements(ALL, 'horizontal');
    expect(patches['a']).toBeUndefined();
    expect(patches['b']).toEqual({ x: 45 });
    expect(patches['c']).toBeUndefined();
  });

  it('distributes vertically the same way', () => {
    // a: y 0 h 10, b: y 30 h 20, c: y 100 h 30.
    // span 130, sizes 60, gap 35 → a at 0, b at 45, c at 100.
    const patches = distributeElements(
      [rect('a', 0, 0, 10, 10), rect('b', 0, 30, 10, 20), rect('c', 0, 100, 10, 30)],
      'vertical'
    );
    expect(patches['a']).toBeUndefined();
    expect(patches['b']).toEqual({ y: 45 });
    expect(patches['c']).toBeUndefined();
  });

  it('does not depend on the order elements are passed in', () => {
    expect(distributeElements([C, A, B], 'horizontal')).toEqual(
      distributeElements(ALL, 'horizontal')
    );
  });

  it('produces genuinely equal gaps', () => {
    const patches = distributeElements(ALL, 'horizontal');
    const placed = ALL.map((element) => elementAABB({ ...element, ...patches[element.id] })).sort(
      (left, right) => left.x - right.x
    );
    const gaps = placed
      .slice(1)
      .map((box, index) => box.x - ((placed[index]?.x ?? 0) + (placed[index]?.width ?? 0)));
    expect(gaps[0]).toBeCloseTo(gaps[1] ?? 0);
  });

  it('handles overlapping elements with a negative but even gap', () => {
    // span 40, sizes 30 → gap = (40 - 30) / 2 = 5. Positive here; make them
    // overlap by shrinking the span instead.
    const patches = distributeElements(
      [rect('a', 0, 0, 20, 10), rect('b', 5, 0, 20, 10), rect('c', 10, 0, 20, 10)],
      'horizontal'
    );
    // span 30, sizes 60 → gap = -15. a at 0, b at 5, c at 10 - already even.
    expect(patches).toEqual({});
  });

  it('is a no-op below three elements - with two, there is only one gap', () => {
    expect(distributeElements([A, B], 'horizontal')).toEqual({});
    expect(distributeElements([A], 'horizontal')).toEqual({});
    expect(distributeElements([], 'vertical')).toEqual({});
  });
});

/*
 * A group is one item to align, and none of the elements that actually move are
 * the item itself: the group's box is a cache the store derives from its
 * members, so a patch naming the group is recomputed away in the same write.
 */
describe('aligning an item that stands for several elements', () => {
  const MEMBER_A = rect('ga', 200, 0, 10, 10);
  const MEMBER_B = rect('gb', 220, 30, 10, 10);
  /** The box the store would derive for a group of the two members above. */
  const GROUP = rect('g', 200, 0, 30, 40);
  const EXPAND: MoveTargets = (element) => (element.id === 'g' ? [MEMBER_A, MEMBER_B] : [element]);

  it('moves the members and never the item', () => {
    const patches = alignElements([A, GROUP], 'left', EXPAND);

    expect(patches['g']).toBeUndefined();
    // Both members shift by the same delta the group box needed: 0 - 200.
    expect(patches['ga']).toEqual({ x: 0 });
    expect(patches['gb']).toEqual({ x: 20 });
  });

  it('preserves the relative offsets inside the item', () => {
    const patches = alignElements([A, GROUP], 'center-x', EXPAND);
    const movedA = patches['ga'];
    const movedB = patches['gb'];

    expect(movedA?.x).toBeDefined();
    expect(movedB?.x).toBeDefined();
    expect((movedB?.x ?? 0) - (movedA?.x ?? 0)).toBe(MEMBER_B.x - MEMBER_A.x);
  });

  it('distributes by the item box and moves the members', () => {
    const patches = distributeElements([A, GROUP, rect('far', 400, 0, 10, 10)], 'horizontal', EXPAND);

    expect(patches['g']).toBeUndefined();
    const movedA = patches['ga'];
    const movedB = patches['gb'];
    if (movedA?.x !== undefined && movedB?.x !== undefined) {
      expect(movedB.x - movedA.x).toBe(MEMBER_B.x - MEMBER_A.x);
    }
  });

  it('is unchanged for callers that pass no expander', () => {
    // The default is the identity, so every pre-group caller keeps its old
    // behaviour without touching a single call site.
    expect(alignElements(ALL, 'left')).toEqual(
      alignElements(ALL, 'left', (element) => [element])
    );
  });
});
