import { describe, expect, it } from 'vitest';

import { rotationPatches, rotationSnapshot } from './rotation';
import { createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store/index';
import type { ElementId } from '@/types';
import { worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();

/**
 * Two 10×10 squares at opposite corners of a 50×50 box, grouped. Their leaf
 * centres are (5, 5) and (45, 45), so the group's derived box is (0, 0, 50, 50)
 * and its centre - the pivot every assertion below is computed against - is
 * (25, 25). Chosen so a quarter turn lands on whole numbers.
 *
 * Deliberately *symmetric*, which is why it cannot be the fixture for the
 * replay tests further down: its pivot is invariant under rotation about itself,
 * so it drifts ~1e-15 no matter how badly the maths composes. See
 * `seedAsymmetric`.
 */
function seedGroup(): { a: ElementId; b: ElementId; group: ElementId } {
  resetCanvasStore();
  const a = createRectangle(worldRect(0, 0, 10, 10));
  const b = createRectangle(worldRect(40, 40, 10, 10));
  state().addElements([a, b]);
  const group = state().group([a.id, b.id]);
  expect(group).not.toBeNull();
  return { a: a.id, b: b.id, group: group ?? '' };
}

/**
 * A group with no symmetry at all: a wide bar, a small square, and a tall box.
 *
 * The union of their boxes is (0, 0, 200, 180), so the pivot is (100, 90) - and
 * unlike `seedGroup`'s, that centre *moves* when the group turns about it,
 * because the union of the leaves' rotated boxes is a different shape at every
 * angle. Any implementation that re-measures the pivot per event and composes
 * small deltas walks this group across the canvas; the symmetric fixture cannot
 * see that at all.
 */
function seedAsymmetric(): {
  bar: ElementId;
  square: ElementId;
  box: ElementId;
  group: ElementId;
} {
  resetCanvasStore();
  const bar = createRectangle(worldRect(0, 0, 200, 10));
  const square = createRectangle(worldRect(0, 100, 10, 10));
  const box = createRectangle(worldRect(150, 60, 40, 120));
  state().addElements([bar, square, box]);
  const group = state().group([bar.id, square.id, box.id]);
  expect(group).not.toBeNull();
  return { bar: bar.id, square: square.id, box: box.id, group: group ?? '' };
}

/**
 * Where a rigid quarter turn about (100, 90) must leave `seedAsymmetric`'s
 * leaves, computed by hand from the geometry rather than from the code: leaf
 * centre minus pivot, rotated a quarter, plus pivot, minus half the extent.
 */
const ASYMMETRIC_QUARTER = {
  bar: { x: 85, y: 85 },
  square: { x: 80, y: -10 },
  box: { x: 50, y: 100 },
};

/** The leaf geometry a scrub or a commit actually produced. */
function geometryOf(ids: readonly ElementId[]): readonly (readonly number[])[] {
  return ids.map((id) => {
    const element = state().elements.byId[id];
    return [element?.x ?? NaN, element?.y ?? NaN, element?.rotation ?? NaN];
  });
}

function expectSameGeometry(
  actual: readonly (readonly number[])[],
  expected: readonly (readonly number[])[]
): void {
  actual.forEach((values, index) => {
    values.forEach((value, axis) => {
      expect(value).toBeCloseTo(expected[index]?.[axis] ?? NaN, 9);
    });
  });
}

/**
 * One angle gesture, as the panel drives it: a single snapshot taken when the
 * gesture starts, then one `rotationPatches` per event. A typed value is the
 * same thing with a single-element `targets` list.
 */
function gesture(ids: Iterable<ElementId>, targets: readonly number[]): void {
  const snapshot = rotationSnapshot(state().elements, ids);
  for (const radians of targets) state().applyPatches(rotationPatches(snapshot, radians));
}

const QUARTER = Math.PI / 2;

/** `count` evenly spaced intermediate angles ending exactly at `total`. */
function ramp(total: number, count: number): readonly number[] {
  return Array.from({ length: count }, (_, index) => (total * (index + 1)) / count);
}

describe('rotationPatches', () => {
  it('turns a group as one body about its centre, the way the handle does', () => {
    const { a, b, group } = seedGroup();

    const patches = rotationPatches(rotationSnapshot(state().elements, [group]), QUARTER);

    // Each leaf's own angle advances *and* its centre orbits the group's: leaf A
    // at centre (5, 5) is (-20, -20) from the pivot, which a quarter turn sends
    // to (20, -20) - centre (45, 5), so a 10×10 box at (40, 0).
    expect(patches[a]?.rotation).toBeCloseTo(QUARTER, 10);
    expect(patches[a]?.x).toBeCloseTo(40, 10);
    expect(patches[a]?.y).toBeCloseTo(0, 10);
    expect(patches[b]?.x).toBeCloseTo(0, 10);
    expect(patches[b]?.y).toBeCloseTo(40, 10);
  });

  it('applies the delta from the snapshot angle, not the angle itself', () => {
    const { a, b, group } = seedGroup();
    // A group already turned a quarter: its leaves sit at 90° and their centres
    // have swapped corners. Asking for 90° again must move nothing at all.
    gesture([group], [QUARTER]);
    const settled = state().elements;

    gesture([group], [QUARTER]);
    expect(state().elements).toBe(settled);

    // And asking for a further quarter turn takes the group to 180°, not back to
    // 90 - the field agrees with dragging the handle the rest of the way.
    const patches = rotationPatches(rotationSnapshot(settled, [group]), Math.PI);
    expect(patches[a]?.rotation).toBeCloseTo(Math.PI, 10);
    expect(patches[b]?.rotation).toBeCloseTo(Math.PI, 10);
  });

  it('sets each leaf in place when the leaves disagree, since there is no delta', () => {
    const { a, b, group } = seedGroup();
    state().updateElement(a, { rotation: QUARTER });
    const before = state().elements;

    const patches = rotationPatches(rotationSnapshot(before, [group]), Math.PI);

    // Every leaf ends up at the asked-for angle, and no centre moves - a splayed
    // group has no single current angle to subtract, so nothing orbits.
    expect(patches[a]?.rotation).toBeCloseTo(Math.PI, 10);
    expect(patches[b]?.rotation).toBeCloseTo(Math.PI, 10);
    expect(Object.keys(patches[a] ?? {})).toEqual(['rotation']);
    expect(Object.keys(patches[b] ?? {})).toEqual(['rotation']);
  });

  it('never turns a locked leaf, but still pivots on the whole group', () => {
    const { a, b, group } = seedGroup();
    state().updateElement(a, { locked: true });

    const patches = rotationPatches(rotationSnapshot(state().elements, [group]), QUARTER);

    expect(patches[a]).toBeUndefined();
    // Leaf B orbits the pivot of the *unfiltered* box (25, 25) - the same centre
    // the rotation handle uses - rather than a centre measured on itself.
    expect(patches[b]?.x).toBeCloseTo(0, 10);
    expect(patches[b]?.y).toBeCloseTo(40, 10);
  });

  it('writes nothing for a group whose every member is locked', () => {
    const { a, b, group } = seedGroup();
    state().updateElement(a, { locked: true });
    state().updateElement(b, { locked: true });

    expect(rotationPatches(rotationSnapshot(state().elements, [group]), QUARTER)).toEqual({});
  });

  it('rotates a loose element in place, exactly as the field always did', () => {
    resetCanvasStore();
    const rect = createRectangle(worldRect(10, 20, 30, 40));
    state().addElement(rect);

    const patches = rotationPatches(rotationSnapshot(state().elements, [rect.id]), QUARTER);

    expect(Object.keys(patches)).toEqual([rect.id]);
    // Only the angle: an element rotates about its own centre, so its box stays.
    expect(Object.keys(patches[rect.id] ?? {})).toEqual(['rotation']);
    expect(patches[rect.id]?.rotation).toBeCloseTo(QUARTER, 10);
  });

  it('treats an angle the element already holds as no edit', () => {
    resetCanvasStore();
    const rect = createRectangle(worldRect(0, 0, 10, 10));
    state().addElement(rect);
    state().updateElement(rect.id, { rotation: QUARTER });
    const before = state().elements;

    // The round trip the field makes - radians to degrees for display, back to
    // radians on commit - is not bit-exact, so this is the case that would cost
    // an undo entry for re-typing the value already on screen. The patch is
    // emitted either way; what matters is that it carries the value the element
    // already holds, so `patchDocument` hands the document straight back.
    const displayed = (QUARTER * 180) / Math.PI;
    gesture([rect.id], [(displayed * Math.PI) / 180]);

    expect(state().elements).toBe(before);
  });

  it('ignores an id that is not in the document', () => {
    resetCanvasStore();

    expect(rotationPatches(rotationSnapshot(state().elements, ['gone']), QUARTER)).toEqual({});
  });
});

/*
  The C1 regression set. A group's pivot is the centre of the union of its
  leaves' *rotated* boxes, and for an asymmetric group that centre is not
  invariant under rotation about itself. So an implementation that re-reads live
  geometry per event - `delta = target - current`, pivot re-measured - is not
  computing the same motion as one commit of the total angle: it composes ~100
  rotations about a pivot that moved under it, drifting 77 world units over a
  single 90° scrub and landing somewhere that depends on the frame rate.
*/
describe('an angle gesture, replayed against its snapshot', () => {
  it('lands an asymmetric group where a rigid turn about its centre must', () => {
    const { bar, square, box, group } = seedAsymmetric();

    gesture([group], [QUARTER]);

    const { byId } = state().elements;
    expect(byId[bar]?.x).toBeCloseTo(ASYMMETRIC_QUARTER.bar.x, 9);
    expect(byId[bar]?.y).toBeCloseTo(ASYMMETRIC_QUARTER.bar.y, 9);
    expect(byId[square]?.x).toBeCloseTo(ASYMMETRIC_QUARTER.square.x, 9);
    expect(byId[square]?.y).toBeCloseTo(ASYMMETRIC_QUARTER.square.y, 9);
    expect(byId[box]?.x).toBeCloseTo(ASYMMETRIC_QUARTER.box.x, 9);
    expect(byId[box]?.y).toBeCloseTo(ASYMMETRIC_QUARTER.box.y, 9);
  });

  it('leaves an asymmetric group exactly where one typed commit would', () => {
    const typed = seedAsymmetric();
    gesture([typed.group], [QUARTER]);
    const committed = geometryOf([typed.bar, typed.square, typed.box]);

    const scrubbed = seedAsymmetric();
    // 90 events: what ~180px of pointer travel at 0.5°/px actually produces.
    gesture([scrubbed.group], ramp(QUARTER, 90));

    expectSameGeometry(geometryOf([scrubbed.bar, scrubbed.square, scrubbed.box]), committed);
  });

  it('does not depend on how many pointermove events fired', () => {
    const few = seedAsymmetric();
    gesture([few.group], ramp(QUARTER, 3));
    const sparse = geometryOf([few.bar, few.square, few.box]);

    const many = seedAsymmetric();
    gesture([many.group], ramp(QUARTER, 240));

    expectSameGeometry(geometryOf([many.bar, many.square, many.box]), sparse);
  });

  it('restores the leaves exactly when a scrub returns to where it began', () => {
    const { bar, square, box, group } = seedAsymmetric();
    const before = geometryOf([bar, square, box]);

    // Out and back: the last event asks for the angle the gesture started from,
    // which has to undo every intermediate write rather than read as "nothing to
    // do" - by then the document has moved.
    gesture([group], [...ramp(QUARTER, 20), 0]);

    // Exactly, not approximately: the zero-delta branch writes the frozen values
    // back verbatim instead of running them through a zero rotation, so the
    // numbers are the ones the gesture started with.
    expect(geometryOf([bar, square, box])).toEqual(before);
  });
});
