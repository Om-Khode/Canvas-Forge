/**
 * What the properties panel's Position and Size fields write.
 *
 * The sibling of `features/properties/rotation`, and it exists for the same
 * reason: a group's `x`/`y`/`width`/`height` are a *derived cache* of its leaves
 * (`store/deriveGroups.ts`), so a patch naming the group's box is recomputed
 * away by `withDerivedGroups` inside the same synchronous write. That is why
 * these four fields used to be switched off for a group - but it only ever ruled
 * out the naive write. The canvas does not patch the group either: dragging its
 * frame translates the **leaves**, and dragging a handle scales them inside the
 * frame (`executeIntents`' `translate`/`resize`). The panel can say exactly the
 * same thing, and this module is where it says it.
 *
 * ### "Set X to N" / "set W to N" means: this object, whole, ends up there
 *
 *  - **A loose element** takes the value directly, through `applicablePatches`
 *    - byte for byte what the fields already did, so an ungrouped document sees
 *    no change at all.
 *  - **A group's X/Y** translate its leaves by `N - box`, so the derived box
 *    lands on the typed coordinate. Translation is rigid, so the box that ends
 *    up at N is the same box the field was showing.
 *  - **A group's W/H** scale its leaves proportionally about the frame's
 *    north-west corner, through `resizeElements`' multi-element branch - handed
 *    the same three things the canvas handle hands it (the unfiltered leaves,
 *    the frame captured at gesture start, a pointer position), plus the handle
 *    the edit stands for: `e` for a width, `s` for a height, `se` when the
 *    aspect lock moves both. **All three pin the north-west corner**, which is
 *    what leaves X and Y reading what they read before: type a width and the
 *    shape grows right and downward, exactly as `{ width: N }` on a loose
 *    element already does. A `w` or an `n` would silently change two other
 *    fields. Which of the three is used matters for one more reason - see
 *    `sizeHandle`.
 *
 * The typed size is turned into a *scale* against the box the fields are
 * showing, and that scale is applied to the resize frame. The two are the same
 * box in every case but one - a group holding a single **rotated** leaf, where
 * `selectionBounds` reports the leaf's own tilted rect while the derived cache
 * holds its axis-aligned extent. That divergence is limitation 2 in
 * `docs/decisions/006-grouping.md` and predates this module; expressing the edit
 * as a ratio is what keeps "type double the width, get double the width" true on
 * the side of it the user is looking at.
 *
 * ### Why a snapshot, and not "read the document and apply a delta"
 *
 * Same reason as the angle field, and the failure is worse. A `NumberField`
 * scrub emits one `onChange` per pointermove - a hundred over one drag - and a
 * width scrub that re-measured the group's box on each of them would divide the
 * new target by a box its own previous event just changed. The scale
 * *compounds*: the group runs away exponentially, and where it lands depends on
 * how many pointermove events happened to fire, i.e. on frame rate. That is
 * `docs/problems-log.md` 008 in a different field.
 *
 * So, exactly as `rotationSnapshot` does: freeze the targets and the frame once
 * per gesture - at `onScrubStart` for a scrub, at the single `onChange` for a
 * typed value - and replay the **absolute** target against that frozen state on
 * every event.
 *
 * ### The aspect lock is part of that freeze, and has to be
 *
 * With the lock on, editing one axis sets the other, and the box deciding what
 * the other becomes is frozen here with everything else. It used to be computed
 * in `PositionSection` from the values the fields were *currently* showing,
 * which left one live read inside the replay loop and re-created the failure
 * above one axis at a time. Harmless while the displayed height tracks the
 * scale - and it stops the moment a leaf hits `MIN_ELEMENT_SIZE`, because the
 * clamped leaf holds the union open in that axis, so the ratio drifts and the
 * outcome depends on how many pointermove events fired. Measured on a group
 * whose right edge is a 5px tick: W 200 → 10 landed at H = 9 typed, 9 over five
 * events and 6.7 over a hundred, and out to 10 and back to 200 left the group
 * ~10% shorter than it started. A divider rule or a hairline is enough to be
 * that tick - which is why the coupling lives in `coupledPatch`, the one place
 * that already knows how to hold a gesture still.
 *
 * ### Two consequences, stated rather than discovered
 *
 *  - **A leaf can hit `MIN_ELEMENT_SIZE` before the group does**, which distorts
 *    the arrangement and stops the group's box reaching the typed size. The
 *    clamp is left where `resizeElements` already puts it instead of being
 *    lifted to a floor on the whole group's scale, because the resize handle
 *    clamps per leaf and a panel that clamped differently would make typing
 *    `W = 5` land somewhere other than dragging to 5. It costs nothing *within*
 *    a gesture - every event replays the frozen geometry, the locked box
 *    included, so a scrub that squashes past the floor and comes back restores
 *    the original exactly - and only the boundary between gestures is lossy,
 *    equally so for the handle.
 *  - **A loose multi-selection still sets each element's W to N, while a group
 *    scales as a unit.** Inherited, not introduced: the same asymmetry already
 *    exists for the angle field and was accepted there. See
 *    `docs/decisions/006-grouping.md`.
 *
 * Pure - document in, patches out. No React and no store handle.
 */

import { elementRect, selectionBounds } from '@/features/selection/bounds';
import {
  resizeElements,
  translateElements,
  type ElementPatch,
  type ElementPatchMap,
} from '@/features/elements/operations';
import { isGroup } from '@/features/elements/tree';
import { applicablePatches, readProperty } from '@/features/properties/mixed';
import { gestureTargets } from '@/features/selection/gestureTargets';
import { transformSet } from '@/features/selection/resolve';
import {
  assertNever,
  type CanvasElement,
  type ElementId,
  type ElementStore,
  type Rect,
  type ResizeHandle,
  type Vec2,
} from '@/types';
import { rectCenter, rotatePoint } from '@/utils/geometry';

/**
 * The canvas handle a typed size stands for, chosen by which axes the edit
 * actually moves. Never reached with both scales at 1 - that is the no-op branch
 * below, which resizes nothing at all.
 *
 * All three pin the frame's north-west corner, so X and Y keep the values they
 * were showing whichever one is used: `resizeBounds` leaves an axis its handle
 * does not name at the extent it started with, and re-centres the box on that
 * axis, which for an unchanged extent is the edge it was already on. So the
 * choice is free geometrically - and it is not free for `releaseAutoHeight`,
 * which is the reason to make it. That function reads "did this gesture change
 * the height?" off the handle, so a fixed `se` made *every* size edit on a group
 * - including a width-only one - permanently switch off auto-sizing on its text
 * leaves, on an axis the user never touched and with nothing in the UI saying
 * so. `e` and `s` are the canvas gestures a width-only and a height-only edit
 * correspond to, and dragging east does not stop a text box auto-sizing. `se` is
 * left for the aspect lock, where the edit genuinely does move both axes and
 * releasing the flag is the same correct answer the corner handle gives.
 */
function sizeHandle(scaleX: number, scaleY: number): ResizeHandle {
  if (scaleX === 1) return 's';
  if (scaleY === 1) return 'e';
  return 'se';
}

/**
 * The box a locked edit preserves the proportions of, frozen with the gesture.
 *
 * Kept as the pair rather than the single ratio it stands for, so the coupled
 * axis can be computed as `other × (driving / driving₀)`. Multiplying by a
 * *scale* returns `other` bit-exactly when the driving axis is retyped
 * unchanged; multiplying by `H₀/W₀` only comes within an ulp of it, and would
 * cost an undo entry for a keystroke that changed nothing. That case has to be
 * free - see the no-op note in `groupPatches`.
 */
interface AspectBox {
  readonly width: number;
  readonly height: number;
}

/** A group, frozen with everything a position or size edit needs to replay. */
interface GroupEntry {
  readonly kind: 'group';
  /** Lock-filtered - the only leaves a write is allowed to land on. */
  readonly leaves: readonly CanvasElement[];
  /**
   * Unfiltered. `resizeElements` picks its proportional-vs-single-element branch
   * on array length, so handing it the filtered set would make a group of two
   * with one locked member resize as if the survivor filled the whole frame -
   * the same trap `executeIntents`' `resize` case documents. Patches for leaves
   * outside `leaves` are computed and then discarded.
   */
  readonly frameElements: readonly CanvasElement[];
  /** The group's derived box: the numbers the fields are actually showing. */
  readonly box: Rect;
  /** The box the resize maths works in, and the angle it is tilted at. */
  readonly frame: Rect;
  readonly frameAngle: number;
}

type GeometryEntry = { readonly kind: 'element'; readonly element: CanvasElement } | GroupEntry;

/** The frozen state a position or size gesture replays against. */
export interface GeometrySnapshot {
  readonly entries: readonly GeometryEntry[];
  /**
   * The proportions a locked edit keeps, or `null` when the lock is off or the
   * selection has no single ratio to keep. See `aspectBox` and `coupledPatch`.
   */
  readonly aspect: AspectBox | null;
}

export interface GeometryGestureOptions {
  /**
   * The editor-wide aspect lock, as it stood when the gesture began. Read here
   * and then frozen with everything else, so toggling the lock mid-scrub cannot
   * redefine a gesture already in flight.
   */
  readonly lockAspect: boolean;
}

/**
 * Freezes what a position or size gesture will act on.
 *
 * Taken once per *gesture* - at pointerdown for a scrub, at the single
 * `onChange` for a typed value, which is a gesture one event long. That is the
 * whole of why the two paths agree: same capture, same replay, different number
 * of events.
 */
export function geometrySnapshot(
  store: ElementStore,
  ids: Iterable<ElementId>,
  options: GeometryGestureOptions
): GeometrySnapshot {
  const entries: GeometryEntry[] = [];
  /*
    Every selected element, groups included and locks not yet applied - the same
    list the fields read their displayed values from, which is what the lock has
    to agree with. Collected here rather than re-derived, because an all-locked
    group is skipped below and must still count towards "do these agree?".
  */
  const selected: CanvasElement[] = [];

  for (const id of ids) {
    const element = store.byId[id];
    if (element === undefined) continue;
    selected.push(element);

    if (!isGroup(element)) {
      entries.push({ kind: 'element', element });
      continue;
    }

    const leaves = gestureTargets(store, [element.id]);
    // Every member locked: the group has nothing this edit may move.
    if (leaves.length === 0) continue;

    const frameElements = transformSet(store, [element.id]);
    const frame = selectionBounds(frameElements);
    // Unreachable while `leaves` is non-empty - the unfiltered set is a superset
    // of it - but scaling against a null frame is NaN geometry, so it is refused
    // rather than asserted away.
    if (frame.kind === 'none') continue;

    entries.push({
      kind: 'group',
      leaves,
      frameElements,
      box: elementRect(element),
      frame: frame.rect,
      frameAngle: frame.rotation,
    });
  }

  return { entries, aspect: options.lockAspect ? aspectBox(selected) : null };
}

/**
 * The one box a locked edit may keep the proportions of, or `null` if there
 * isn't one.
 *
 * Uniform across the whole selection or nothing. With the sizes disagreeing
 * there is no single ratio to preserve, and inventing one - the first element's,
 * say - would resize everything else by a number the user never saw. A lone
 * group is uniform by construction, so this is the derived box the edit is
 * measured against, which is what makes both scales come out equal and the
 * members keep their arrangement.
 *
 * Both extents must be positive: a zero-extent box has no proportions, and a
 * zero would send the coupled axis to Infinity or NaN.
 */
function aspectBox(elements: readonly CanvasElement[]): AspectBox | null {
  const width = readProperty(elements, 'width');
  const height = readProperty(elements, 'height');
  if (width.kind !== 'uniform' || height.kind !== 'uniform') return null;
  if (width.value <= 0 || height.value <= 0) return null;
  return { width: width.value, height: height.value };
}

/**
 * The aspect lock, applied to the target before anything is measured against it.
 *
 * Here rather than in the panel because this is the module that holds a gesture
 * still - the docblock's "the aspect lock is part of that freeze" section is the
 * whole argument. `patch.width` and `patch.height` are absolute targets, so a
 * scale computed against the frozen box is the same scale on every event of a
 * scrub, and the typed value is the one-event case of it.
 *
 * A patch that names both axes is left alone: the caller has already said what
 * it wants on each, and a lock cannot overrule that without discarding half the
 * instruction. A patch that names neither (a move) has nothing to couple.
 */
function coupledPatch(aspect: AspectBox | null, patch: ElementPatch): ElementPatch {
  if (aspect === null) return patch;
  if (patch.width !== undefined && patch.height === undefined) {
    return { ...patch, height: aspect.height * (patch.width / aspect.width) };
  }
  if (patch.height !== undefined && patch.width === undefined) {
    return { ...patch, width: aspect.width * (patch.height / aspect.height) };
  }
  return patch;
}

/**
 * Patches that leave every object in the snapshot at the box `patch` describes.
 *
 * Absolute, never incremental: the result depends only on the snapshot and the
 * target values, so replaying it a hundred times during a scrub produces the
 * same document as evaluating it once for a typed value. Every entry is patched
 * on every call - `patchDocument` compares by value and hands the document back
 * untouched when nothing moved, which is what keeps a gesture that ends where it
 * started out of history.
 */
export function geometryPatches(snapshot: GeometrySnapshot, patch: ElementPatch): ElementPatchMap {
  const patches: Record<ElementId, ElementPatch> = {};
  // Couple once, for the whole selection: the lock is a statement about the box
  // the fields describe, not about each member of it.
  const target = coupledPatch(snapshot.aspect, patch);

  for (const entry of snapshot.entries) {
    switch (entry.kind) {
      case 'element':
        // Unchanged from what the fields have always done, deliberately: a
        // document with no groups in it must see no difference whatsoever -
        // including under the lock, where the panel used to compute the same
        // coupled pair from the same numbers and hand it straight to here.
        Object.assign(patches, applicablePatches([entry.element], target));
        break;

      case 'group':
        Object.assign(patches, groupPatches(entry, target));
        break;

      default:
        assertNever(entry, 'geometry snapshot entry');
    }
  }

  return patches;
}

/**
 * The leaf patches that put a group's derived box where `patch` asks.
 *
 * Position and size are computed independently and composed, because the two
 * anchors are different: `se` holds the frame's north-west corner still, so a
 * translation can simply be added on top of whatever the scale produced. The
 * panel never sends both at once today - X/Y and W/H are separate fields - but
 * a rule that only works because of how the caller happens to be wired is a rule
 * that breaks silently later.
 */
function groupPatches(entry: GroupEntry, patch: ElementPatch): ElementPatchMap {
  const scaleX = axisScale(patch.width, entry.box.width);
  const scaleY = axisScale(patch.height, entry.box.height);
  const dxWorld = patch.x === undefined ? 0 : patch.x - entry.box.x;
  const dyWorld = patch.y === undefined ? 0 : patch.y - entry.box.y;

  /*
    Exact comparison, and no tolerance constant. Unlike the angle field, W and H
    are stored and displayed in the same unit, so there is no radians → degrees →
    radians round trip manufacturing residue for a tolerance to absorb; and a
    tolerance in *world units* would be a different amount of screen at every
    zoom level, so there is no honest value to pick. Retyping the value on screen
    divides a number by itself and gives exactly 1, which is the case that has to
    be free - and stays free under the aspect lock, because `coupledPatch`
    reaches the other axis by multiplying by that same exact 1.
  */
  const scaled =
    scaleX === 1 && scaleY === 1
      ? null
      : resizeElements(
          entry.frameElements,
          entry.frame,
          sizeHandle(scaleX, scaleY),
          sizeCorner(entry.frame, entry.frameAngle, scaleX, scaleY)
        );

  const patches: Record<ElementId, ElementPatch> = {};

  if (scaled === null) {
    /*
      A pure move *is* the canvas drag, so it goes through the same function.
      The frozen extents ride along because this is also where a size gesture
      lands once it returns to the value it started from - scale exactly 1, no
      translation. At rest that pair is a no-op: `patchDocument` compares by
      value and hands the document straight back. Mid-scrub it is the whole
      point, because by then the document has moved and "nothing to do" would
      leave the leaves at whatever the previous event made them.
    */
    const moved = translateElements(entry.leaves, dxWorld, dyWorld);
    for (const leaf of entry.leaves) {
      patches[leaf.id] = { ...moved[leaf.id], width: leaf.width, height: leaf.height };
    }
    return patches;
  }

  for (const leaf of entry.leaves) {
    // Every leaf is in `frameElements`, so the fallback is unreachable - but a
    // missing entry would otherwise write `undefined` into the document.
    const sized = scaled[leaf.id] ?? elementRect(leaf);
    patches[leaf.id] =
      dxWorld === 0 && dyWorld === 0
        ? sized
        : { ...sized, x: (sized.x ?? leaf.x) + dxWorld, y: (sized.y ?? leaf.y) + dyWorld };
  }

  return patches;
}

/** How much bigger the field is asking the box to be. Absent means "unchanged". */
function axisScale(target: number | undefined, current: number): number {
  // A zero-extent box has no ratio to scale by, and dividing would hand
  // `resizeElements` an Infinity. It already refuses the same case internally.
  if (target === undefined || current === 0) return 1;
  return target / current;
}

/**
 * The world point that, grabbed by the `se` handle, gives the frame `scaleX` by
 * `scaleY` its original size.
 *
 * `resizeBounds` derives the new extents from the pointer expressed in the
 * frame's own rotated basis - `q = R(-θ)·(pointer - centre)`, then
 * `width = q.x + halfW`. Inverting that for a known target is one rotation
 * forwards, which is all this is. For the ordinary unrotated frame it collapses
 * to "the box's bottom-right corner".
 */
function sizeCorner(frame: Rect, angle: number, scaleX: number, scaleY: number): Vec2 {
  const center = rectCenter(frame);
  const corner = {
    x: center.x + frame.width * scaleX - frame.width / 2,
    y: center.y + frame.height * scaleY - frame.height / 2,
  };
  return angle === 0 ? corner : rotatePoint(corner, center, angle);
}
