/**
 * Picking.
 *
 * The core trick: rather than transforming each *shape* into world space and
 * testing a rotated polygon, the *point* is pushed into the element's local
 * space by the inverse of its matrix. Every shape test then runs against an
 * axis-aligned figure at the origin, which is two comparisons for a rectangle
 * and one normalized radius for an ellipse. One inverse per element replaces a
 * bespoke rotated test per element type.
 *
 * Elements arrive in paint order (bottom → top) and are walked in reverse, so
 * the first hit is the topmost - the one the user can see and therefore the one
 * they meant to click.
 */

import { STROKE_HIT_TOLERANCE_PX } from '@/constants';
import { screenLengthToWorld } from '@/utils/coords';
import {
  distancePointToSegment,
  expandRect,
  rectContainsPoint,
  rectsIntersect,
  rotatedBounds,
} from '@/utils/geometry';
import {
  assertNever,
  type CanvasElement,
  type Rect,
  type Vec2,
  type Viewport,
  type WorldPoint,
} from '@/types';
import { applyToPoint, inverseElementMatrix } from './matrix';

/**
 * Hidden elements aren't visible to click, and locked ones are explicitly opted
 * out of pointer interaction - that is what the lock is for. Groups are excluded
 * for a different reason: not "should not be picked" but "has nothing to pick",
 * since a group's box is a cache of its members rather than geometry of its own.
 * All three are skipped here rather than filtered by the caller so every picking
 * path agrees.
 *
 * This can only see the element's own flags. Hidden or locked *ancestors* are
 * the caller's business, via the `isEligible` predicate below - the engine is
 * handed a flat array and has no view of the tree.
 */
export function isPickable(element: CanvasElement): boolean {
  // A group has no geometry of its own to hit. Clicks land on a member and the
  // selection layer walks up to the outermost group - see features/selection.
  if (element.type === 'group') return false;
  return element.visible && !element.locked;
}

/**
 * An extra per-element veto, applied on top of `isPickable`.
 *
 * Exists so a caller that *does* know the element tree can refuse a member of a
 * hidden or locked group without the engine having to learn about parentage.
 */
export type PickEligibility = (element: CanvasElement) => boolean;

/** Topmost pickable element containing `worldPoint`, or `null`. */
export function hitTestPoint(
  worldPoint: WorldPoint,
  elements: readonly CanvasElement[],
  viewport: Viewport,
  isEligible?: PickEligibility
): CanvasElement | null {
  // A fixed screen-pixel tolerance converted to world units, so a hairline
  // stroke stays clickable when zoomed out and the target doesn't become an
  // absurdly fat band when zoomed in.
  const tolerance = screenLengthToWorld(STROKE_HIT_TOLERANCE_PX, viewport);

  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];
    if (element === undefined || !isPickable(element)) continue;
    if (isEligible !== undefined && !isEligible(element)) continue;

    const inverse = inverseElementMatrix(element);
    // An element matrix is translate ∘ rotate, whose determinant is always 1,
    // so this branch is unreachable today. It is kept because `invert` is
    // honest about singularity and the day a scale term joins the composition
    // is the day this stops being unreachable - better a skipped element than
    // NaN coordinates propagating into the selection.
    if (inverse === null) continue;

    // The element matrix is translate ∘ rotate only - no scale - so a distance
    // in local units is the same distance in world units and the tolerance
    // needs no further conversion.
    const local = applyToPoint(inverse, worldPoint);
    if (containsLocalPoint(element, local, tolerance)) return element;
  }

  return null;
}

/**
 * Marquee selection: every pickable element whose rotation-aware world AABB
 * overlaps `worldRect`, returned in paint order.
 *
 * AABB intersection rather than exact shape overlap. It's one comparison per
 * axis instead of a polygon clip, and it matches what users expect: dragging a
 * box across a rotated shape's corner selects it. Precision here would be
 * pedantry that costs frames during the drag.
 */
export function hitTestRect(
  worldRect: Rect,
  elements: readonly CanvasElement[],
  isEligible?: PickEligibility
): CanvasElement[] {
  const hits: CanvasElement[] = [];
  for (const element of elements) {
    if (!isPickable(element)) continue;
    if (isEligible !== undefined && !isEligible(element)) continue;
    if (rectsIntersect(worldRect, elementWorldBounds(element))) hits.push(element);
  }
  return hits;
}

function elementWorldBounds(element: CanvasElement): Rect {
  return rotatedBounds(
    { x: element.x, y: element.y, width: element.width, height: element.height },
    element.rotation
  );
}

/* ----------------------------------------------------- per-type local tests -- */

function containsLocalPoint(element: CanvasElement, local: Vec2, tolerance: number): boolean {
  const box: Rect = { x: 0, y: 0, width: element.width, height: element.height };

  switch (element.type) {
    case 'rectangle':
      return element.fill !== null
        ? rectContainsPoint(expandRect(box, tolerance), local)
        : nearRectBorder(box, local, tolerance + strokeBand(element.strokeWidth));

    case 'ellipse':
      return element.fill !== null
        ? insideEllipse(box, local, tolerance)
        : nearEllipseEdge(box, local, tolerance + strokeBand(element.strokeWidth));

    case 'line':
    case 'arrow': {
      const start = { x: element.start.x * element.width, y: element.start.y * element.height };
      const end = { x: element.end.x * element.width, y: element.end.y * element.height };
      return distancePointToSegment(local, start, end) <= tolerance + strokeBand(element.strokeWidth);
    }

    case 'text':
    case 'image':
      // Both are opaque rectangular content as far as picking goes. Testing the
      // glyph coverage of text would make clicking the gaps between letters
      // deselect, which no editor does.
      return rectContainsPoint(expandRect(box, tolerance), local);

    case 'freehand':
      return nearFreehandStroke(element.points, element, local, tolerance);

    case 'group':
      // Unreachable - `isPickable` filters groups out before either caller gets
      // here. Kept so the switch stays exhaustive against the union rather than
      // relying on a guard in another function to hold forever.
      return false;

    default:
      return assertNever(element, 'element type');
  }
}

/** Half the stroke straddles the path on each side, so that half is clickable. */
function strokeBand(strokeWidth: number): number {
  return strokeWidth / 2;
}

/**
 * A hollow shape is only clickable near its outline. Implemented as
 * "inside the outer band and not inside the inner band" - the inner rect is the
 * box shrunk by the band, and `expandRect` floors extents at zero, so a shape
 * thinner than twice the band degenerates to solid rather than to nothing.
 */
function nearRectBorder(box: Rect, local: Vec2, band: number): boolean {
  if (!rectContainsPoint(expandRect(box, band), local)) return false;
  return !rectContainsPoint(expandRect(box, -band), local);
}

/**
 * Point-in-ellipse via the normalized form: a point is inside when
 * ((x-cx)/rx)² + ((y-cy)/ry)² ≤ 1. Tolerance is applied by inflating the radii
 * rather than by comparing against a fudged constant - inflating the radii
 * keeps the band a uniform width in the thin direction of a very flat ellipse,
 * which a scalar fudge does not.
 */
function insideEllipse(box: Rect, local: Vec2, tolerance: number): boolean {
  return ellipseRadialTerm(box, local, tolerance) <= 1;
}

function nearEllipseEdge(box: Rect, local: Vec2, band: number): boolean {
  if (ellipseRadialTerm(box, local, band) > 1) return false;
  // The inner boundary uses a negative inflation. If either shrunk radius goes
  // non-positive the ellipse is thinner than the band, so treat it as solid.
  const radiusX = box.width / 2 - band;
  const radiusY = box.height / 2 - band;
  if (radiusX <= 0 || radiusY <= 0) return true;
  return ellipseRadialTerm(box, local, -band) > 1;
}

function ellipseRadialTerm(box: Rect, local: Vec2, inflate: number): number {
  const radiusX = box.width / 2 + inflate;
  const radiusY = box.height / 2 + inflate;
  if (radiusX <= 0 || radiusY <= 0) return Infinity;
  const dx = (local.x - box.width / 2) / radiusX;
  const dy = (local.y - box.height / 2) / radiusY;
  return dx * dx + dy * dy;
}

/**
 * Freehand strokes are tested segment by segment against the raw sample points,
 * not against the smoothed curve the drawer paints. The smoothing moves the
 * path by at most half a sample spacing, which is well inside the tolerance
 * band - and testing a quadratic Bézier per segment would cost a root solve per
 * segment per pointermove for no perceptible gain.
 *
 * The bounding-box early-out matters: a long stroke can hold thousands of
 * points, and most elements the walk passes over are nowhere near the cursor.
 */
function nearFreehandStroke(
  points: readonly Vec2[],
  element: { readonly width: number; readonly height: number; readonly strokeWidth: number },
  local: Vec2,
  tolerance: number
): boolean {
  const band = tolerance + strokeBand(element.strokeWidth);
  const box: Rect = { x: 0, y: 0, width: element.width, height: element.height };
  if (!rectContainsPoint(expandRect(box, band), local)) return false;

  if (points.length === 1) {
    const only = points[0];
    if (only === undefined) return false;
    return Math.hypot(local.x - only.x * element.width, local.y - only.y * element.height) <= band;
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    const segmentStart = { x: a.x * element.width, y: a.y * element.height };
    const segmentEnd = { x: b.x * element.width, y: b.y * element.height };
    if (distancePointToSegment(local, segmentStart, segmentEnd) <= band) return true;
  }

  return false;
}
