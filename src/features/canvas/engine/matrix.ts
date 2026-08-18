/**
 * 2D affine transforms.
 *
 * Layout - the flat `Matrix2D` tuple is `[a, b, c, d, e, f]`, the six
 * meaningful cells of a 3x3 homogeneous matrix stored *column-major*, which is
 * the order the Canvas 2D API takes them in (`ctx.transform(a,b,c,d,e,f)`):
 *
 *     | a  c  e |        x' = a*x + c*y + e
 *     | b  d  f |        y' = b*x + d*y + f
 *     | 0  0  1 |
 *
 * So `a`/`d` are the axis scales, `b`/`c` the shear-or-rotation terms, and
 * `e`/`f` the translation. Matching the canvas order means a matrix can be
 * handed straight to the context with no shuffling - the transform the
 * hit-tester inverts is bit-for-bit the transform the renderer painted with,
 * which is the property that makes clicks land where shapes look.
 *
 * The bottom row is always [0 0 1]; affine transforms cannot change it, so
 * storing it would be six wasted multiplies per compose.
 */

import type { CanvasElement, Matrix2D, Vec2 } from '@/types';

export const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0];

/**
 * Below this determinant a matrix is treated as singular. Not `=== 0`: a
 * transform scaled to 1e-9 is arithmetically invertible but the inverse has
 * entries around 1e9, and running a pointer coordinate through it produces
 * garbage rather than an error. Refusing early turns a silent wrong answer into
 * a `null` the caller must handle.
 */
const SINGULAR_EPSILON = 1e-12;

/**
 * Matrix product `a · b` - the transform that applies **b first, then a**.
 *
 * That ordering (right-to-left, like function composition) is the mathematical
 * convention and the one `ctx.transform` follows, so `compose(...)` reads in the
 * same direction as the equivalent sequence of canvas calls.
 *
 * Derived by expanding the 3x3 product and dropping the fixed bottom row; the
 * `+ a.e` / `+ a.f` terms on the translation come from b's homogeneous 1.
 */
export function multiply(a: Matrix2D, b: Matrix2D): Matrix2D {
  const [a0, a1, a2, a3, a4, a5] = a;
  const [b0, b1, b2, b3, b4, b5] = b;
  return [
    a0 * b0 + a2 * b1,
    a1 * b0 + a3 * b1,
    a0 * b2 + a2 * b3,
    a1 * b2 + a3 * b3,
    a0 * b4 + a2 * b5 + a4,
    a1 * b4 + a3 * b5 + a5,
  ];
}

/** Left-to-right convenience: `compose(m1, m2, m3)` applies m1, then m2, then m3. */
export function compose(...matrices: readonly Matrix2D[]): Matrix2D {
  // Reduced right-to-left because `multiply(a, b)` means "b first".
  let result: Matrix2D = IDENTITY;
  for (let i = matrices.length - 1; i >= 0; i -= 1) {
    const next = matrices[i];
    if (next !== undefined) result = multiply(result, next);
  }
  return result;
}

/**
 * Inverse, or `null` when the matrix collapses space (zero scale on an axis).
 *
 * Returns rather than throws because the caller - a hit-test on an element
 * someone dragged to zero width - has a sensible answer available ("nothing was
 * hit"), and an exception there would take down a pointermove handler.
 *
 * For the 2x2 linear part the inverse is the adjugate over the determinant.
 * The translation column is then `-M⁻¹·t`, expanded inline below.
 */
export function invert(m: Matrix2D): Matrix2D | null {
  const [a, b, c, d, e, f] = m;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < SINGULAR_EPSILON) return null;

  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

export function applyToPoint(m: Matrix2D, point: Vec2): Vec2 {
  const [a, b, c, d, e, f] = m;
  return {
    x: a * point.x + c * point.y + e,
    y: b * point.x + d * point.y + f,
  };
}

export function fromTranslation(tx: number, ty: number): Matrix2D {
  return [1, 0, 0, 1, tx, ty];
}

/** Clockwise in screen axes, where y grows downward. */
export function fromRotation(radians: number): Matrix2D {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

export function fromScale(sx: number, sy: number): Matrix2D {
  return [sx, 0, 0, sy, 0, 0];
}

/**
 * The element's local-space → world-space transform.
 *
 * Local space has its origin at the element's **top-left**, unrotated, so every
 * drawer can paint at (0,0)–(width,height) and never think about the angle.
 *
 * Composition, in the order a reader would describe it:
 *
 *   1. `T(-w/2, -h/2)` - move the local origin to the element's centre, because
 *      rotation is defined about the centre and a rotation matrix always pivots
 *      about *its* origin.
 *   2. `R(θ)` - rotate.
 *   3. `T(cx, cy)` - move the centre out to its world position.
 *
 *   M = T(cx, cy) · R(θ) · T(-w/2, -h/2)
 *
 * (Read right-to-left: the rightmost factor acts on the point first.) Note the
 * first translation is *not* `T(-cx, -cy)`; the local origin is already at the
 * top-left rather than at the world origin, so the offset needed is only the
 * half-extent. Expanding `T(cx,cy)·T(-cx,-cy)·T(x,y)` gives the same thing -
 * this is that product already simplified.
 *
 * Unrotated elements - the overwhelming majority - short-circuit to a plain
 * translation, skipping two matrix multiplies and two trig calls per element
 * per frame.
 */
export function elementMatrix(element: CanvasElement): Matrix2D {
  const { x, y, width, height, rotation } = element;
  if (rotation === 0) return fromTranslation(x, y);

  return multiply(
    multiply(fromTranslation(x + width / 2, y + height / 2), fromRotation(rotation)),
    fromTranslation(-width / 2, -height / 2)
  );
}

/** Element-local ← world. `null` when the element has collapsed to zero area. */
export function inverseElementMatrix(element: CanvasElement): Matrix2D | null {
  return invert(elementMatrix(element));
}
