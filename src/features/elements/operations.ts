/**
 * Pure transform maths for move / resize / rotate / reorder.
 *
 * Every function here is `(elements, …) => patches` or `(order, …) => order`.
 * No store, no React, no side effects - the interaction layer feeds these the
 * live pointer position on every `pointermove` and hands the result to
 * `applyPatches`, and the tests can drive them with hand-computed numbers.
 */

import { MIN_ELEMENT_SIZE, ROTATION_SNAP_RADIANS } from '@/constants';
import { elementBounds, elementRect } from '@/features/selection/bounds';
import { rectCenter, unionRects } from '@/utils/geometry';
import type {
  ArrowElement,
  CanvasElement,
  ElementId,
  EllipseElement,
  FreehandElement,
  ImageElement,
  LineElement,
  Rect,
  RectangleElement,
  ResizeHandle,
  TextElement,
  Vec2,
} from '@/types';

/**
 * A partial update to one element.
 *
 * Built as `Partial` of the *intersection* of every variant rather than of the
 * union: `keyof` a union is only the keys they all share, which would silently
 * drop `fill`, `text`, `points`, and every other variant-specific field. The
 * variants have no conflicting property types once `type` is removed, so the
 * intersection is exactly "every property any element can have". The store
 * checks the patch against the element it lands on.
 *
 * `id` and `type` are dropped *before* intersecting, not after: TypeScript
 * reduces an intersection with conflicting literal discriminants
 * (`'rectangle' & 'ellipse'`) to `never`, which would silently collapse the
 * whole patch type into something that accepts nothing.
 */
type PatchableProps<T> = Omit<T, 'id' | 'type'>;

type AnyElementProps = PatchableProps<RectangleElement> &
  PatchableProps<EllipseElement> &
  PatchableProps<LineElement> &
  PatchableProps<ArrowElement> &
  PatchableProps<TextElement> &
  PatchableProps<ImageElement> &
  PatchableProps<FreehandElement>;

export type ElementPatch = Partial<AnyElementProps>;

export type ElementPatchMap = Readonly<Record<ElementId, ElementPatch>>;

/* ---------------------------------------------------------------- bounds -- */

/*
 * These three delegate to the canonical implementations rather than carrying
 * their own. The rotated-AABB formula lives in `utils/geometry.rotatedBounds`
 * and its element-aware wrapper in `features/selection/bounds`, because the
 * renderer's culling pass and the overlay both need the same answer - and two
 * copies of "what box does this element occupy" is exactly the kind of
 * duplication that drifts silently once one side gains a special case.
 *
 * They stay exported under these names because the transform and alignment
 * maths reads better with them close at hand.
 */

export function elementCenter(element: CanvasElement): Vec2 {
  return rectCenter(elementRect(element));
}

/**
 * The axis-aligned world box an element actually occupies. For a rotated
 * element that is *not* `{x, y, width, height}` - a square turned 45° covers a
 * box √2 times wider - and alignment and marquee tests want the visible extent.
 */
export const elementAABB = elementBounds;

/** Union of the elements' AABBs. An empty selection has no box, hence zero. */
export function unionBounds(elements: readonly CanvasElement[]): Rect {
  return unionRects(elements.map(elementBounds)) ?? { x: 0, y: 0, width: 0, height: 0 };
}

/* ------------------------------------------------------------- translate -- */

export function translateElements(
  elements: readonly CanvasElement[],
  dxWorld: number,
  dyWorld: number
): ElementPatchMap {
  const patches: Record<ElementId, ElementPatch> = {};
  for (const element of elements) {
    patches[element.id] = { x: element.x + dxWorld, y: element.y + dyWorld };
  }
  return patches;
}

/* ---------------------------------------------------------------- resize -- */

export interface ResizeOptions {
  readonly preserveAspect?: boolean;
  readonly fromCenter?: boolean;
  readonly minSize?: number;
}

function rotate(vector: Vec2, radians: number): Vec2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

/**
 * The new selection box, given where the pointer is now.
 *
 * ### Why the arithmetic happens in a local frame
 *
 * A rotated element resized in world space produces a sheared, wandering box:
 * the handle the user grabbed is not on a world axis, so "drag right" is not
 * "make wider". The fix is to stop transforming the shape and transform the
 * *pointer* instead - the same trick hit-testing uses.
 *
 *   c   = centre of the original box (world)
 *   θ   = the box's rotation
 *   q   = R(-θ) · (worldPoint - c)          pointer, in the box's own frame
 *
 * In that frame the box is axis-aligned and spans [-w/2, w/2] × [-h/2, h/2], so
 * the handle maths is the trivial unrotated case. Once new local extents
 * (l, r, t, b) are known, the box's centre has moved by m = ((l+r)/2, (t+b)/2)
 * *in local coordinates*, so the new world centre is:
 *
 *   c' = c + R(θ) · m
 *
 * which is what keeps the corner opposite the grabbed handle pinned in world
 * space. θ = 0 collapses all of this to plain addition, so there is one code
 * path, not two.
 */
function resizeBounds(
  bounds: Rect,
  handle: ResizeHandle,
  worldPoint: Vec2,
  angle: number,
  options: ResizeOptions
): Rect {
  const minSize = options.minSize ?? MIN_ELEMENT_SIZE;
  const fromCenter = options.fromCenter ?? false;
  const preserveAspect = options.preserveAspect ?? false;

  const halfW = bounds.width / 2;
  const halfH = bounds.height / 2;
  const center = { x: bounds.x + halfW, y: bounds.y + halfH };
  const q = rotate({ x: worldPoint.x - center.x, y: worldPoint.y - center.y }, -angle);

  const movesLeft = handle.includes('w');
  const movesRight = handle.includes('e');
  const movesTop = handle.includes('n');
  const movesBottom = handle.includes('s');

  // 1. Raw extents implied by the pointer. From-centre mirrors the dragged edge
  //    across the centre, so the box grows twice as fast and stays put.
  let width = bounds.width;
  if (movesLeft) width = fromCenter ? -2 * q.x : halfW - q.x;
  else if (movesRight) width = fromCenter ? 2 * q.x : q.x + halfW;

  let height = bounds.height;
  if (movesTop) height = fromCenter ? -2 * q.y : halfH - q.y;
  else if (movesBottom) height = fromCenter ? 2 * q.y : q.y + halfH;

  // 2. Aspect lock. Corners take the larger of the two implied scales so the
  //    box always follows the pointer outwards; edges are driven by their axis.
  if (preserveAspect && bounds.width > 0 && bounds.height > 0) {
    const scaleX = width / bounds.width;
    const scaleY = height / bounds.height;
    const horizontal = movesLeft || movesRight;
    const vertical = movesTop || movesBottom;
    const scale = horizontal && vertical ? Math.max(scaleX, scaleY) : horizontal ? scaleX : scaleY;
    width = bounds.width * scale;
    height = bounds.height * scale;
  }

  // 3. Clamp. Negative extents mean the pointer crossed the anchor; the box is
  //    pinned at the minimum rather than flipped, so no element ever inverts.
  //    Under aspect lock the minimum has to be applied along the ratio, not per
  //    axis, or the shape would distort at the floor.
  if (preserveAspect && bounds.width > 0 && bounds.height > 0) {
    width = Math.max(width, 0);
    height = Math.max(height, 0);
    if (width < minSize || height < minSize) {
      const ratio = bounds.width / bounds.height;
      width = Math.max(minSize, minSize * ratio);
      height = Math.max(minSize, minSize / ratio);
    }
  } else {
    width = Math.max(width, minSize);
    height = Math.max(height, minSize);
  }

  // 4. Place the extents against whichever edge stayed put.
  const left =
    fromCenter || (!movesLeft && !movesRight) ? -width / 2 : movesLeft ? halfW - width : -halfW;
  const top =
    fromCenter || (!movesTop && !movesBottom) ? -height / 2 : movesTop ? halfH - height : -halfH;

  const localShift = { x: left + width / 2, y: top + height / 2 };
  const worldShift = rotate(localShift, angle);
  return {
    x: center.x + worldShift.x - width / 2,
    y: center.y + worldShift.y - height / 2,
    width,
    height,
  };
}

/**
 * `originalBounds` is the selection's box **as captured at drag start**: for a
 * lone element its own unrotated `{x, y, width, height}`, for a multi-selection
 * the union of AABBs. Passing the live box each move would compound rounding
 * and make the shape creep.
 *
 * A single element resizes in its own rotated frame. A multi-selection scales
 * each member proportionally inside the world-axis group box - members keep
 * their own rotation, which is approximate for rotated members but is what
 * every 2D editor does and what users expect.
 */
export function resizeElements(
  elements: readonly CanvasElement[],
  originalBounds: Rect,
  handle: ResizeHandle,
  worldPoint: Vec2,
  options: ResizeOptions = {}
): ElementPatchMap {
  const only = elements.length === 1 ? elements[0] : undefined;
  const angle = only?.rotation ?? 0;
  const next = resizeBounds(originalBounds, handle, worldPoint, angle, options);

  if (only !== undefined) {
    return {
      [only.id]: {
        x: next.x,
        y: next.y,
        width: next.width,
        height: next.height,
        ...releaseAutoHeight(only, handle),
      },
    };
  }

  const scaleX = originalBounds.width === 0 ? 1 : next.width / originalBounds.width;
  const scaleY = originalBounds.height === 0 ? 1 : next.height / originalBounds.height;
  const minSize = options.minSize ?? MIN_ELEMENT_SIZE;

  const patches: Record<ElementId, ElementPatch> = {};
  for (const element of elements) {
    patches[element.id] = {
      x: next.x + (element.x - originalBounds.x) * scaleX,
      y: next.y + (element.y - originalBounds.y) * scaleY,
      width: Math.max(element.width * scaleX, minSize),
      height: Math.max(element.height * scaleY, minSize),
      ...releaseAutoHeight(element, handle),
    };
  }
  return patches;
}

/** The handles that change a box's height. `e`/`w` move only its sides. */
const HEIGHT_HANDLES: ReadonlySet<ResizeHandle> = new Set<ResizeHandle>([
  'n',
  's',
  'ne',
  'nw',
  'se',
  'sw',
]);

/**
 * Dragging a text box's height is the gesture that means "stop auto-sizing".
 *
 * Without this the resize appears to work and then silently undoes itself: the
 * patch sets a new height, `autoHeight` stays true, and the next keystroke
 * recomputes the height from the content. The user drags, sees it take, types a
 * character, and watches the box snap back - with nothing in the UI to explain
 * why. Releasing the flag here keeps the decision next to the geometry that
 * triggers it, rather than in the editing overlay which would have to infer it.
 */
function releaseAutoHeight(
  element: CanvasElement,
  handle: ResizeHandle
): { autoHeight?: false } {
  if (element.type !== 'text' || !element.autoHeight) return {};
  return HEIGHT_HANDLES.has(handle) ? { autoHeight: false } : {};
}

/* ---------------------------------------------------------------- rotate -- */

/** Keeps stored angles in [0, 2π) so the properties panel never shows -540°. */
export function normalizeAngle(radians: number): number {
  const full = Math.PI * 2;
  return ((radians % full) + full) % full;
}

/**
 * Rotates every element by `radians` about a shared world centre: each
 * element's own angle advances *and* its centre orbits, which is what makes a
 * multi-selection rotate as one rigid body instead of each shape spinning in
 * place.
 *
 * Snapping applies to the *delta*, not to each element's absolute angle -
 * snapping absolutes would collapse a deliberately-splayed group into
 * alignment the moment Shift is pressed.
 */
export function rotateElements(
  elements: readonly CanvasElement[],
  centerWorld: Vec2,
  radians: number,
  snap = false
): ElementPatchMap {
  const delta = snap
    ? Math.round(radians / ROTATION_SNAP_RADIANS) * ROTATION_SNAP_RADIANS
    : radians;

  const patches: Record<ElementId, ElementPatch> = {};
  for (const element of elements) {
    const center = elementCenter(element);
    const orbited = rotate({ x: center.x - centerWorld.x, y: center.y - centerWorld.y }, delta);
    patches[element.id] = {
      rotation: normalizeAngle(element.rotation + delta),
      x: centerWorld.x + orbited.x - element.width / 2,
      y: centerWorld.y + orbited.y - element.height / 2,
    };
  }
  return patches;
}

