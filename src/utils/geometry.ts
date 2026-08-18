/**
 * Rectangle and rotation maths on plain, unbranded geometry.
 *
 * Everything here is a pure function of `Rect`/`Vec2`. Deliberately unbranded:
 * the same union-of-boxes logic serves world-space culling and screen-space
 * overlay layout, and duplicating it once per coordinate space would be two
 * copies of the same off-by-one bugs. Callers that care about the space keep
 * their branded types at the boundary and hand plain rects inward.
 */

import type { Rect, Vec2 } from '@/types';

/**
 * Angles below this are treated as unrotated. `rotation` arrives from user
 * drags and from JSON round-trips, so an exact `=== 0` test misses values like
 * 1e-17 and would push every element down the slower rotated path - and, worse,
 * grow its AABB by a hair, which makes culling and selection boxes jitter.
 */
const ANGLE_EPSILON = 1e-9;

/**
 * Rewrites a rectangle so `width`/`height` are non-negative.
 *
 * Drag-created rects are `{ origin, current - origin }`, which is negative in
 * whichever direction the user dragged backwards. Every predicate below assumes
 * `x` is the left edge, so normalizing once at the boundary is cheaper than
 * defending in each of them.
 */
export function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/** Builds the normalized rectangle spanned by two corner points. */
export function rectFromPoints(a: Vec2, b: Vec2): Rect {
  return normalizeRect({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y });
}

/**
 * Overlap test, expressed as the negation of the four separating cases.
 *
 * Written as "not disjoint" rather than four positive comparisons because the
 * disjoint form has one obvious reading per axis, and because it makes the
 * boundary convention explicit: rectangles that merely *touch* count as
 * intersecting. That is what culling wants - an element flush against the
 * viewport edge is still partly on screen.
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/** Inclusive of the border, matching `rectsIntersect`'s touching convention. */
export function rectContainsPoint(rect: Rect, point: Vec2): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** True when `inner` lies entirely within `outer`. Used by strict marquee modes. */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Smallest rectangle containing all inputs, or `null` for an empty list.
 *
 * `null` rather than a zero rect: "no selection" and "a selection of zero area
 * at the origin" are different states, and collapsing them means the overlay
 * happily draws a degenerate box around nothing.
 */
export function unionRects(rects: readonly Rect[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const rect of rects) {
    if (rect.x < minX) minX = rect.x;
    if (rect.y < minY) minY = rect.y;
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
  }

  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectCenter(rect: Rect): Vec2 {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Grows (or, with a negative amount, shrinks) a rectangle by `amount` on every
 * side. Extents are floored at zero so an over-shrink produces an empty rect
 * rather than an inside-out one that `rectsIntersect` would report as disjoint
 * from things it actually straddles.
 */
export function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: Math.max(0, rect.width + amount * 2),
    height: Math.max(0, rect.height + amount * 2),
  };
}

/**
 * Rotates `point` about `center` by `radians` (clockwise in screen axes, where
 * y grows downward).
 *
 * Standard 2D rotation applied to the offset from the pivot:
 *
 *     [x']   [cos  -sin] [x - cx]   [cx]
 *     [y'] = [sin   cos] [y - cy] + [cy]
 */
export function rotatePoint(point: Vec2, center: Vec2, radians: number): Vec2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * Axis-aligned bounding box of `rect` after rotating it about its own centre.
 *
 * The closed form, rather than rotating four corners and taking min/max:
 * a corner sits at offset (±w/2, ±h/2) from the centre, so after rotation its
 * x-offset is ±(w/2)·cos θ ∓ (h/2)·sin θ. The extreme over the four sign
 * combinations is reached when both terms have the same sign, which is exactly
 * (w/2)·|cos θ| + (h/2)·|sin θ|. Same argument on y with cos and sin swapped.
 *
 * Costs two trig calls instead of four rotations plus eight comparisons, and it
 * runs once per element per frame during culling.
 */
export function rotatedBounds(rect: Rect, rotation: number): Rect {
  const normalized = normalizeRect(rect);
  if (Math.abs(rotation) < ANGLE_EPSILON) return normalized;

  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const width = normalized.width * cos + normalized.height * sin;
  const height = normalized.width * sin + normalized.height * cos;
  const center = rectCenter(normalized);

  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

/**
 * Shortest distance from a point to the *segment* ab (not the infinite line).
 *
 * Projects the point onto ab in parameter space - t = (ap·ab)/|ab|² - then
 * clamps t to [0, 1]. The clamp is what turns a line test into a segment test:
 * without it, a click far past an arrow's tip would register as a hit.
 * Degenerate segments (a === b) fall back to point distance.
 */
export function distancePointToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;

  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSquared));
  return Math.hypot(point.x - (a.x + abx * t), point.y - (a.y + aby * t));
}
