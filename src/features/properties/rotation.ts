/**
 * What the properties panel's angle field reads, and what an angle edit writes.
 *
 * A group owns no rotation. `store/deriveGroups.ts` re-derives its box from its
 * leaves and deliberately never touches its `rotation`, while the canvas rotate
 * gesture patches the *leaves* - orbiting each about the group's centre and
 * advancing each leaf's own angle. So `group.rotation` is the one number in the
 * document guaranteed never to change: the group visibly turns and a field
 * reading it keeps saying 0. This module is the leaf-shaped answer to both
 * halves of that, kept out of the panel because it is policy plus maths, not
 * markup.
 *
 * ### "Set the angle to N" means: this object, whole, ends up at N
 *
 * One sentence covers every selection, and each case follows from it:
 *
 *  - **A loose element** reaches N by taking N. Rotation is about its own
 *    centre, so its box does not move - exactly what the field already did.
 *  - **A group** reaches N by turning as one rigid body about its own centre, by
 *    the delta `N - current`. This is the identical operation the rotation
 *    handle performs (`executeIntents`' `rotate` case → `rotateElements`), which
 *    is the point: drag the handle to 30° and the field reads 30; type 45 and the
 *    group turns the remaining 15°, just as dragging further would have. Setting
 *    each leaf's *absolute* angle to N instead would spin the members in place
 *    and leave the arrangement pointing the wrong way, so the field and the
 *    gesture would disagree about what the same number means.
 *  - **A group whose leaves disagree** has no single `current` to subtract, so
 *    there is no delta to apply. Each leaf takes N in place: every centre stays
 *    put, the field ends up reading N either way, and it is the same thing the
 *    field already does for a mixed rotation across a loose multi-selection.
 *    Note what the first such edit does to the *next* one - see
 *    `docs/decisions/006-grouping.md`: once every leaf holds N the leaves agree,
 *    so the following edit takes the rigid branch above.
 *
 * ### Why a snapshot, and not "read the document and apply a delta"
 *
 * Both halves are exported because the field is driven by **two** gestures, and
 * only one of them is a single event. Typing a value fires one `onChange`;
 * *scrubbing* the label fires one per pointermove - ~0.5° per pixel, so easily a
 * hundred over one drag. Recomputing `N - current` against the live document on
 * each of those composes a hundred small rotations, and for a group that is not
 * the same motion as one big one: the pivot is the centre of the union of the
 * leaves' *rotated* boxes, which for an asymmetric group moves when the group
 * turns about it. Composed, the body walks across the canvas - measured at 77
 * world units over a 90° scrub - and where it lands depends on how many
 * pointermove events happened to fire, i.e. on frame rate.
 *
 * So this mirrors the structure the rotate *gesture* already uses
 * (`executeIntents`' `GestureSnapshot`): freeze the targets and the pivot when
 * the gesture starts, then replay the **absolute** angle against that frozen
 * state on every event. A hundred events and one event produce the same
 * document, because each one is computed from the same origin rather than from
 * its predecessor's output.
 *
 * Which elements the field reads and writes is not decided here:
 * `features/properties/targets` owns that, because the position and size fields
 * need the identical answer.
 *
 * Pure - document in, patches out. No React and no store handle, so all of the
 * interesting cases are testable without mounting a panel.
 */

import { ROTATION_NOOP_RADIANS } from '@/constants';
import {
  normalizeAngle,
  rotateElements,
  type ElementPatch,
  type ElementPatchMap,
} from '@/features/elements/operations';
import { isGroup } from '@/features/elements/tree';
import { readProperty } from '@/features/properties/mixed';
import { selectionBounds } from '@/features/selection/bounds';
import { gestureTargets } from '@/features/selection/gestureTargets';
import { transformSet } from '@/features/selection/resolve';
import {
  assertNever,
  type CanvasElement,
  type ElementId,
  type ElementStore,
  type Vec2,
} from '@/types';
import { rectCenter } from '@/utils/geometry';

/**
 * One selected object, frozen at the instant the angle gesture began, plus
 * whatever that object needs to be put at an absolute angle later.
 */
type RotationEntry =
  /** A loose element: reaches any angle by taking it, about its own centre. */
  | { readonly kind: 'element'; readonly element: CanvasElement }
  /** A group whose leaves agreed: turns as one body about a fixed pivot. */
  | {
      readonly kind: 'rigid';
      readonly leaves: readonly CanvasElement[];
      readonly pivotWorld: Vec2;
      /** The angle the leaves shared, and so the origin every delta is from. */
      readonly angle: number;
    }
  /** A group whose leaves disagreed: no shared origin, so no delta exists. */
  | { readonly kind: 'splayed'; readonly leaves: readonly CanvasElement[] };

/** The frozen state an angle gesture replays against. See the docblock above. */
export interface RotationSnapshot {
  readonly entries: readonly RotationEntry[];
}

/**
 * Freezes what an angle gesture will act on: the targets, the pivot they turn
 * about, and the angle they started from.
 *
 * Taken once per *gesture* - at pointerdown for a scrub, and at the single
 * `onChange` for a typed value, which is a gesture one event long. That is the
 * whole of why the two paths agree: same capture, same replay, different number
 * of events.
 */
export function rotationSnapshot(store: ElementStore, ids: Iterable<ElementId>): RotationSnapshot {
  const entries: RotationEntry[] = [];

  for (const id of ids) {
    const element = store.byId[id];
    if (element === undefined) continue;

    if (!isGroup(element)) {
      entries.push({ kind: 'element', element });
      continue;
    }

    // Lock-filtered, exactly as `transformTargets` would expand it: a locked
    // member is not this gesture's to turn.
    const leaves = gestureTargets(store, [element.id]);
    // Every member locked: the group has nothing this edit may turn.
    if (leaves.length === 0) continue;

    const current = readProperty(leaves, 'rotation');
    if (current.kind !== 'uniform') {
      entries.push({ kind: 'splayed', leaves });
      continue;
    }

    /*
      The pivot is measured over the *unfiltered* leaves, because that is the box
      the rotation handle pivots on (`usePointerInteraction.probeUnderPointer`
      measures `transformSet`, locked members included). Measuring the
      lock-filtered set instead would put the field's centre somewhere else than
      the gesture's the moment one member is locked, and the same typed angle
      would land the group in two different places.
    */
    const frame = selectionBounds(transformSet(store, [element.id]));
    // Unreachable while `leaves` is non-empty - the unfiltered set is a superset
    // of it - but a rotation about a null pivot is NaN geometry, so it is
    // refused rather than asserted away.
    if (frame.kind === 'none') continue;

    entries.push({
      kind: 'rigid',
      leaves,
      pivotWorld: rectCenter(frame.rect),
      angle: current.value,
    });
  }

  return { entries };
}

/**
 * Patches that leave every object in the snapshot sitting at `radians`.
 *
 * Absolute, never incremental: the result depends only on the snapshot and the
 * target angle, so replaying it a hundred times during a scrub produces the same
 * document as evaluating it once for a typed value. Every entry is patched on
 * every call - `patchDocument` compares by value and returns the document
 * untouched when nothing moved, which is what keeps a gesture that ends where it
 * started out of history, exactly as the canvas drag path relies on.
 */
export function rotationPatches(snapshot: RotationSnapshot, radians: number): ElementPatchMap {
  const target = normalizeAngle(radians);
  const patches: Record<ElementId, ElementPatch> = {};

  for (const entry of snapshot.entries) {
    switch (entry.kind) {
      case 'element':
        patches[entry.element.id] = { rotation: settledAngle(entry.element.rotation, target) };
        break;

      case 'splayed':
        for (const leaf of entry.leaves) {
          patches[leaf.id] = { rotation: settledAngle(leaf.rotation, target) };
        }
        break;

      case 'rigid': {
        const delta = target - entry.angle;
        if (isRotation(delta, 0)) {
          /*
            Zero net travel: write the frozen geometry back *verbatim* rather
            than running it through a zero rotation. `normalizeAngle` is not
            bit-idempotent, so `rotateElements(…, 0)` would mint angles up to
            9e-16 away from the ones it was handed; `patchDocument` would see a
            change, and a gesture that moved nothing would orbit every member by
            a hundredth of a nanoradian and cost an undo entry. Restoring the
            snapshot is also the honest answer mid-scrub, where the document has
            since moved and "nothing to do" would be wrong.
          */
          for (const leaf of entry.leaves) {
            patches[leaf.id] = { x: leaf.x, y: leaf.y, rotation: leaf.rotation };
          }
          break;
        }
        Object.assign(patches, rotateElements(entry.leaves, entry.pivotWorld, delta));
        break;
      }

      default:
        assertNever(entry, 'rotation snapshot entry');
    }
  }

  return patches;
}

/**
 * `target`, unless the element is already there - in which case its own value,
 * so the patch compares equal and the document keeps its identity.
 *
 * The angle field shows degrees to one decimal, so the smallest edit it can
 * describe is ~1e-3 rad - six orders of magnitude above the tolerance. Anything
 * closer than that is the float residue of a radians → degrees → radians round
 * trip through the input, not an edit.
 */
function settledAngle(current: number, target: number): number {
  return isRotation(current, target) ? current : target;
}

/** Same angle, as far as this field can express. */
function isRotation(current: number, target: number): boolean {
  return Math.abs(target - current) < ROTATION_NOOP_RADIANS;
}
