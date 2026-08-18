/**
 * Geometry primitives and the branded coordinate-space types.
 *
 * The single most common bug class in a canvas editor is arithmetic that mixes
 * screen pixels with world units. The two are structurally identical - both are
 * `{ x, y }` - so nothing but discipline stops you from subtracting one from the
 * other. Branding makes that discipline a compile error instead.
 *
 * The brand exists only in the type system; at runtime a WorldPoint is a plain
 * object. Brands are applied and removed in `utils/coords.ts` and nowhere else.
 */

declare const spaceBrand: unique symbol;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** A point in CSS pixels, relative to the canvas element's top-left corner. */
export type ScreenPoint = Point & { readonly [spaceBrand]: 'screen' };

/** A point in document space. Unbounded - the canvas is infinite. */
export type WorldPoint = Point & { readonly [spaceBrand]: 'world' };

/** A delta in world units. Distinct from a position so the two can't be swapped. */
export type WorldVector = Point & { readonly [spaceBrand]: 'world-delta' };

/** An unbranded pair, for the rare case where the space genuinely doesn't matter. */
export type Vec2 = Point;

/** Axis-aligned rectangle. `width`/`height` are always non-negative once normalized. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A rectangle in world space, e.g. an element's bounding box. */
export type WorldRect = Rect & { readonly [spaceBrand]: 'world' };

/** A rectangle in screen space, e.g. the visible canvas area. */
export type ScreenRect = Rect & { readonly [spaceBrand]: 'screen' };

/**
 * A 2D affine transform stored as the six meaningful values of the 3x3 matrix,
 * in the same order the Canvas 2D API uses:
 *
 *   | a  c  e |      x' = a*x + c*y + e
 *   | b  d  f |      y' = b*x + d*y + f
 *   | 0  0  1 |
 *
 * A flat tuple rather than an object because these are multiplied in hot paths
 * (once per element per frame) and destructuring a tuple is free.
 */
export type Matrix2D = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** The eight resize handles plus the rotation handle, named by compass position. */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export type TransformHandle = ResizeHandle | 'rotate';
