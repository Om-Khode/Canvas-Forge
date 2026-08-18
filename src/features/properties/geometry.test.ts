import { describe, expect, it } from 'vitest';

import { geometryPatches, geometrySnapshot, type GeometryGestureOptions } from './geometry';
import { MIN_ELEMENT_SIZE } from '@/constants';
import { createRectangle, createText } from '@/features/elements/factory';
import type { ElementPatch } from '@/features/elements/operations';
import { resetCanvasStore, useCanvasStore } from '@/store/index';
import type { ElementId } from '@/types';
import { worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();

/**
 * Two 10×10 squares at opposite corners of a 50×50 box, grouped, so the group's
 * derived box is (0, 0, 50, 50). Enough for the cases that only need "is this
 * one leaf written or not"; every scale assertion uses `seedAsymmetric`.
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
 * Their union is (0, 0, 200, 180).
 *
 * Deliberately asymmetric, and the three leaves sit at three different offsets
 * from the frame's north-west corner - so a scale that composes per event
 * instead of replaying an absolute target moves each of them by a *different*
 * wrong amount, which a fixture of identical squares at mirrored positions could
 * hide. The square is also small enough to reach `MIN_ELEMENT_SIZE` long before
 * the group's own box does.
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
 * The fixture the aspect-lock failure was measured on, with its measured
 * numbers: a 190-wide bar, a 5×5 tick and a 20×180 upright, grouped into the
 * same (0, 0, 200, 180) box as `seedAsymmetric` - but with the **right edge set
 * by the tick**.
 *
 * That is what makes it bite. `MIN_ELEMENT_SIZE` is 1, so the tick clamps on the
 * *first* event of any downward scrub and then stops shrinking while its
 * siblings keep going, which inflates the union's width relative to the scale
 * the gesture asked for. Any group whose right or bottom edge is set by a thin
 * member is this fixture - a divider rule, a hairline, an underline.
 */
function seedThinEdge(): {
  bar: ElementId;
  tick: ElementId;
  upright: ElementId;
  group: ElementId;
} {
  resetCanvasStore();
  const bar = createRectangle(worldRect(0, 0, 190, 10));
  const tick = createRectangle(worldRect(195, 100, 5, 5));
  const upright = createRectangle(worldRect(50, 0, 20, 180));
  state().addElements([bar, tick, upright]);
  const group = state().group([bar.id, tick.id, upright.id]);
  expect(group).not.toBeNull();
  return { bar: bar.id, tick: tick.id, upright: upright.id, group: group ?? '' };
}

/** An auto-height text box grouped with a plain rectangle. */
function seedTextGroup(): { text: ElementId; rect: ElementId; group: ElementId } {
  resetCanvasStore();
  const text = createText(worldRect(0, 0, 100, 20));
  const rect = createRectangle(worldRect(0, 40, 100, 40));
  state().addElements([text, rect]);
  const group = state().group([text.id, rect.id]);
  expect(group).not.toBeNull();
  // The flag the size edit must not clear behind the user's back.
  expect(state().elements.byId[text.id]).toMatchObject({ autoHeight: true });
  return { text: text.id, rect: rect.id, group: group ?? '' };
}

/** The leaf geometry a scrub or a commit actually produced. */
function geometryOf(ids: readonly ElementId[]): readonly (readonly number[])[] {
  return ids.map((id) => {
    const element = state().elements.byId[id];
    return [element?.x ?? NaN, element?.y ?? NaN, element?.width ?? NaN, element?.height ?? NaN];
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

/** The lock off, which is what all but the aspect-lock cases want. */
const UNLOCKED = { lockAspect: false } as const;
const LOCKED = { lockAspect: true } as const;

/**
 * One position or size gesture, as the panel drives it: a single snapshot taken
 * when the gesture starts, then one `geometryPatches` per event. A typed value
 * is the same thing with a one-element list.
 */
function gesture(
  ids: Iterable<ElementId>,
  targets: readonly ElementPatch[],
  options: GeometryGestureOptions = UNLOCKED
): void {
  const snapshot = geometrySnapshot(state().elements, ids, options);
  for (const patch of targets) state().applyPatches(geometryPatches(snapshot, patch));
}

/** `count` evenly spaced widths from the fixture's 200 up (or down) to `total`. */
function widthRamp(total: number, count: number): readonly ElementPatch[] {
  return Array.from({ length: count }, (_, index) => ({
    width: 200 + ((total - 200) * (index + 1)) / count,
  }));
}

describe('a loose element', () => {
  it('takes the typed value directly, exactly as the field always did', () => {
    resetCanvasStore();
    const rect = createRectangle(worldRect(10, 20, 30, 40));
    state().addElement(rect);

    const patches = geometryPatches(geometrySnapshot(state().elements, [rect.id], UNLOCKED), {
      x: 5,
    });

    // One key, one element: an ungrouped document must not be able to tell that
    // any of this exists.
    expect(patches).toEqual({ [rect.id]: { x: 5 } });
  });

  it('keeps the loose multi-selection rule: W sets every element to N', () => {
    resetCanvasStore();
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 30, 30));
    state().addElements([a, b]);

    const patches = geometryPatches(geometrySnapshot(state().elements, [a.id, b.id], UNLOCKED), {
      width: 100,
    });

    // Not a scale of the pair as a unit - the same asymmetry the angle field
    // already has, inherited on purpose. See docs/decisions/006-grouping.md.
    expect(patches).toEqual({ [a.id]: { width: 100 }, [b.id]: { width: 100 } });
  });

  it('treats a value the element already holds as no edit', () => {
    resetCanvasStore();
    const rect = createRectangle(worldRect(10, 20, 30, 40));
    state().addElement(rect);
    const before = state().elements;

    gesture([rect.id], [{ x: 10 }, { width: 30 }]);

    expect(state().elements).toBe(before);
  });
});

describe('a group', () => {
  it('translates its leaves so the derived box lands on the typed X', () => {
    const { bar, square, box, group } = seedAsymmetric();

    gesture([group], [{ x: 25 }]);

    const { byId } = state().elements;
    // Rigid: every leaf moves by the same +25, and no extent changes.
    expect(byId[bar]?.x).toBe(25);
    expect(byId[square]?.x).toBe(25);
    expect(byId[box]?.x).toBe(175);
    expect(byId[bar]?.width).toBe(200);
    // Which is the whole point of translating rather than patching the cache:
    // the box the field showed is the box that ends up at 25.
    expect(byId[group]?.x).toBe(25);
  });

  it('scales its leaves about the frame’s north-west corner for a typed W', () => {
    const { bar, square, box, group } = seedAsymmetric();

    gesture([group], [{ width: 400 }]);

    const { byId } = state().elements;
    // A width-only edit is the `e` handle, which pins (0, 0), so X and Y read
    // the same afterwards as before - the two fields the user did not touch.
    expect(byId[group]?.x).toBe(0);
    expect(byId[group]?.y).toBe(0);
    expect(byId[group]?.width).toBe(400);
    // Each leaf's offset from that corner doubles along with its own width.
    expect(byId[bar]?.width).toBeCloseTo(400, 9);
    expect(byId[square]?.width).toBeCloseTo(20, 9);
    expect(byId[box]?.x).toBeCloseTo(300, 9);
    expect(byId[box]?.width).toBeCloseTo(80, 9);
    // The untouched axis is untouched.
    expect(byId[box]?.y).toBeCloseTo(60, 9);
    expect(byId[box]?.height).toBeCloseTo(120, 9);
  });

  it('scales both axes together when the aspect lock couples them', () => {
    const { bar, box, group } = seedAsymmetric();

    // One axis is all the W field sends. The lock supplies the other from the
    // 200×180 box frozen in the snapshot, so both scales are 2 - and the field's
    // own value is *not* consulted, which is the whole of C1.
    gesture([group], [{ width: 400 }], LOCKED);

    const { byId } = state().elements;
    expect(byId[group]?.width).toBeCloseTo(400, 9);
    expect(byId[group]?.height).toBeCloseTo(360, 9);
    expect(byId[bar]?.height).toBeCloseTo(20, 9);
    expect(byId[box]?.y).toBeCloseTo(120, 9);
    expect(byId[box]?.height).toBeCloseTo(240, 9);
  });

  it('never moves a locked leaf, but still measures the whole frame', () => {
    const { a, b, group } = seedGroup();
    state().updateElement(a, { locked: true });
    const frozen = state().elements.byId[a];

    const patches = geometryPatches(geometrySnapshot(state().elements, [group], UNLOCKED), {
      width: 100,
    });

    expect(patches[a]).toBeUndefined();
    // B scales about the *unfiltered* frame's corner (0, 0) - the same box the
    // resize handle grabs - rather than about a box measured on B alone.
    expect(patches[b]?.x).toBeCloseTo(80, 9);
    expect(patches[b]?.width).toBeCloseTo(20, 9);

    state().applyPatches(patches);
    expect(state().elements.byId[a]).toBe(frozen);
  });

  it('writes nothing for a group whose every member is locked', () => {
    const { a, b, group } = seedGroup();
    state().updateElement(a, { locked: true });
    state().updateElement(b, { locked: true });

    expect(
      geometryPatches(geometrySnapshot(state().elements, [group], UNLOCKED), { width: 100 })
    ).toEqual({});
  });

  it('treats the value already on screen as no edit at all', () => {
    const { group } = seedAsymmetric();
    const before = state().elements;

    // Both fields, both axes: retyping what is displayed divides a number by
    // itself, which is exactly 1, so nothing is written and the document keeps
    // its identity - no undo entry for a keystroke that changed nothing.
    gesture([group], [{ x: 0 }, { y: 0 }, { width: 200 }, { height: 180 }]);

    expect(state().elements).toBe(before);
  });

  it('ignores an id that is not in the document', () => {
    resetCanvasStore();

    expect(
      geometryPatches(geometrySnapshot(state().elements, ['gone'], UNLOCKED), { x: 1 })
    ).toEqual({});
  });
});

describe('a mixed selection', () => {
  it('gives the loose element the value and scales the group to it', () => {
    resetCanvasStore();
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const loose = createRectangle(worldRect(100, 0, 20, 20));
    state().addElements([a, b, loose]);
    const group = state().group([a.id, b.id]) ?? '';

    gesture([group, loose.id], [{ width: 100 }]);

    const { byId } = state().elements;
    // The loose element takes 100 outright…
    expect(byId[loose.id]?.width).toBe(100);
    // …while the group's 50-wide box doubles, which means its members double.
    expect(byId[a.id]?.width).toBeCloseTo(20, 9);
    expect(byId[b.id]?.x).toBeCloseTo(80, 9);
    expect(byId[group]?.width).toBeCloseTo(100, 9);
  });

  it('moves each of them to the same typed X in its own way', () => {
    resetCanvasStore();
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const loose = createRectangle(worldRect(100, 0, 20, 20));
    state().addElements([a, b, loose]);
    const group = state().group([a.id, b.id]) ?? '';

    gesture([group, loose.id], [{ x: 5 }]);

    const { byId } = state().elements;
    expect(byId[loose.id]?.x).toBe(5);
    expect(byId[group]?.x).toBe(5);
    // The group got there by translating, so its members kept their spacing.
    expect(byId[b.id]?.x).toBe(45);
  });
});

/*
  The drift regression set, and the reason `geometrySnapshot` is mandatory rather
  than an optimisation. A width scrub emits one `onChange` per pointermove; an
  implementation that divided the new target by the group's *current* box would
  be dividing by a box its own previous event had just changed, so the scale
  compounds and the group runs away - landing somewhere that depends on how many
  pointermove events happened to fire, i.e. on frame rate. Same family as
  docs/problems-log.md 008, in a different field.
*/
describe('a size gesture, replayed against its snapshot', () => {
  it('leaves an asymmetric group exactly where one typed commit would', () => {
    const typed = seedAsymmetric();
    gesture([typed.group], [{ width: 400 }]);
    const committed = geometryOf([typed.bar, typed.square, typed.box]);

    const scrubbed = seedAsymmetric();
    // 100 events: what a pointer drag across the width of the panel produces.
    gesture([scrubbed.group], widthRamp(400, 100));

    expectSameGeometry(geometryOf([scrubbed.bar, scrubbed.square, scrubbed.box]), committed);
  });

  it('does not depend on how many pointermove events fired', () => {
    const few = seedAsymmetric();
    gesture([few.group], widthRamp(400, 3));
    const sparse = geometryOf([few.bar, few.square, few.box]);

    const many = seedAsymmetric();
    gesture([many.group], widthRamp(400, 240));

    expectSameGeometry(geometryOf([many.bar, many.square, many.box]), sparse);
  });

  it('restores the leaves exactly when a scrub returns to where it began', () => {
    const { bar, square, box, group } = seedAsymmetric();
    const before = geometryOf([bar, square, box]);

    gesture([group], [...widthRamp(400, 20), { width: 200 }]);

    // Exactly, not approximately: the closing event has scale 1, which writes
    // the frozen geometry back verbatim rather than running it through a resize.
    expect(geometryOf([bar, square, box])).toEqual(before);
  });

  it('restores the leaves exactly when a move scrub returns to where it began', () => {
    const { bar, square, box, group } = seedAsymmetric();
    const before = geometryOf([bar, square, box]);

    gesture([group], [{ x: 40 }, { x: 90 }, { x: 12 }, { x: 0 }]);

    expect(geometryOf([bar, square, box])).toEqual(before);
  });
});

/*
  The floor. Scaling a group down far enough clamps its smallest member at
  `MIN_ELEMENT_SIZE`, which distorts the arrangement - the leaf stops shrinking
  while its siblings keep going. Left where `resizeElements` already puts it,
  rather than lifted to a floor on the whole group's scale, so that typing a
  width and dragging a handle to it land in the same place.
*/
describe('the minimum element size', () => {
  it('clamps the leaf that reaches it and lets the rest keep shrinking', () => {
    const { bar, square, group } = seedAsymmetric();

    // A twentieth: the 200-wide bar has room to spare, the 10-wide square does
    // not - 0.5 is below the floor.
    gesture([group], [{ width: 10 }]);

    const { byId } = state().elements;
    expect(byId[bar]?.width).toBeCloseTo(10, 9);
    expect(byId[square]?.width).toBe(MIN_ELEMENT_SIZE);
  });

  it('is lossless within one gesture, because every event replays the snapshot', () => {
    const { bar, square, box, group } = seedAsymmetric();
    const before = geometryOf([bar, square, box]);

    // Squash past the floor and come back. Nothing accumulates: the closing
    // event is computed from the frozen geometry, not from the clamped document
    // the previous event left behind.
    gesture([group], [{ width: 40 }, { width: 10 }, { width: 4 }, { width: 200 }]);

    expect(geometryOf([bar, square, box])).toEqual(before);
  });
});

/*
  The aspect lock used to be the one live read left inside the replay loop.
  `PositionSection` divided the height the fields were *currently* showing by the
  width they were currently showing, so every event of a width scrub coupled
  against a box its own previous event had produced - and the moment a leaf
  clamped at `MIN_ELEMENT_SIZE`, that box stopped tracking the scale. Measured on
  `seedThinEdge` before the freeze: W 200 → 10 gave H = 9 typed, 9 over five
  events and 6.708 over a hundred, and a scrub out to 10 and back to 200 left the
  group ~10% shorter than it started. Every case here sends **one** axis and lets
  `coupledPatch` supply the other, which is what the panel now does.
*/
describe('the aspect lock, frozen with the gesture', () => {
  it('lands a scrub exactly where the typed value lands', () => {
    const typed = seedThinEdge();
    gesture([typed.group], [{ width: 10 }], LOCKED);
    const committed = geometryOf([typed.bar, typed.tick, typed.upright]);

    // The measured pair. Not 10 × 9, because the clamped tick holds the union
    // open - that part is the documented per-leaf floor, and it is the same for
    // both gestures, which is the property under test.
    expect(state().elements.byId[typed.group]?.width).toBeCloseTo(10.75, 9);
    expect(state().elements.byId[typed.group]?.height).toBeCloseTo(9, 9);

    const scrubbed = seedThinEdge();
    // 100 events: what a pointer drag across the width of the panel produces.
    gesture([scrubbed.group], widthRamp(10, 100), LOCKED);

    expectSameGeometry(geometryOf([scrubbed.bar, scrubbed.tick, scrubbed.upright]), committed);
    expect(state().elements.byId[scrubbed.group]?.height).toBeCloseTo(9, 9);
  });

  it('does not depend on how many pointermove events fired', () => {
    const few = seedThinEdge();
    gesture([few.group], widthRamp(10, 5), LOCKED);
    const sparse = geometryOf([few.bar, few.tick, few.upright]);

    const many = seedThinEdge();
    gesture([many.group], widthRamp(10, 100), LOCKED);

    // The frame-rate dependence, which is what made this a correctness bug and
    // not a rounding complaint.
    expectSameGeometry(geometryOf([many.bar, many.tick, many.upright]), sparse);
  });

  it('restores the document exactly when a locked scrub goes out and back', () => {
    const { bar, tick, upright, group } = seedThinEdge();
    const before = geometryOf([bar, tick, upright]);

    gesture([group], [...widthRamp(10, 20), { width: 200 }], LOCKED);

    // Exactly, not approximately: the closing event's coupled height is the
    // frozen 180 multiplied by an exact 1, so both scales are exactly 1 and the
    // frozen geometry is written back verbatim.
    expect(geometryOf([bar, tick, upright])).toEqual(before);
  });

  it('costs nothing to retype the size already on screen', () => {
    const { group } = seedThinEdge();
    const before = state().elements;

    // Both fields: the lock reaches the other axis by multiplying the frozen
    // extent by a scale, which for a retyped value is exactly 1 - where
    // multiplying by a stored `H/W` ratio would be an ulp off and cost an undo
    // entry for a keystroke that changed nothing.
    gesture([group], [{ width: 200 }, { height: 180 }], LOCKED);

    expect(state().elements).toBe(before);
  });

  it('has no ratio to keep when the selected sizes disagree', () => {
    resetCanvasStore();
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 30, 20));
    state().addElements([a, b]);

    gesture([a.id, b.id], [{ width: 100 }], LOCKED);

    // Inventing one - the first element's, say - would resize the other by a
    // number the user never saw, so the lock stands down and H is untouched.
    expect(state().elements.byId[a.id]).toMatchObject({ width: 100, height: 10 });
    expect(state().elements.byId[b.id]).toMatchObject({ width: 100, height: 20 });
  });
});

/*
  Which canvas handle a typed size stands for, decided by `sizeHandle`. It is
  invisible in the geometry - all three of `e`, `s` and `se` pin the frame's
  north-west corner - and visible in exactly one place: `resizeElements` reads
  "did this gesture change the height?" off the handle, and switches a text
  leaf's `autoHeight` off when the answer is yes. With the handle fixed at `se`,
  a width-only edit turned auto-sizing off on an axis the user never touched.
*/
describe('an auto-height text box inside a group', () => {
  it('keeps auto-sizing when only the width is edited', () => {
    const { text, group } = seedTextGroup();

    gesture([group], [{ width: 200 }]);

    // The corresponding canvas gesture is the east handle, which does not
    // release the flag either.
    expect(state().elements.byId[text]).toMatchObject({ autoHeight: true });
  });

  it('releases it when the height is edited', () => {
    const { text, group } = seedTextGroup();

    gesture([group], [{ height: 200 }]);

    // "Set a height" *is* the gesture that means stop auto-sizing - the south
    // handle's answer, and the only axis this edit touched.
    expect(state().elements.byId[text]).toMatchObject({ autoHeight: false });
  });

  it('releases it for a width edit under the aspect lock, which moves both axes', () => {
    const { text, group } = seedTextGroup();

    gesture([group], [{ width: 200 }], LOCKED);

    expect(state().elements.byId[text]).toMatchObject({ autoHeight: false });
  });
});
