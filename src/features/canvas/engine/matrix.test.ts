import { describe, expect, it } from 'vitest';
import type { CanvasElement, Matrix2D, RectangleElement } from '@/types';
import {
  IDENTITY,
  applyToPoint,
  compose,
  elementMatrix,
  fromRotation,
  fromScale,
  fromTranslation,
  inverseElementMatrix,
  invert,
  multiply,
} from './matrix';

const PRECISION = 10;

function expectMatrixClose(actual: Matrix2D, expected: Matrix2D): void {
  for (let i = 0; i < 6; i += 1) {
    expect(actual[i] ?? NaN).toBeCloseTo(expected[i] ?? NaN, PRECISION);
  }
}

function rect(overrides: Partial<RectangleElement> = {}): CanvasElement {
  return {
    id: 'r1',
    type: 'rectangle',
    name: 'Rect',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    strokeStyle: 'solid',
    cornerRadius: 0,
    ...overrides,
  };
}

describe('IDENTITY', () => {
  it('leaves points where they are', () => {
    expect(applyToPoint(IDENTITY, { x: 3, y: -7 })).toEqual({ x: 3, y: -7 });
  });

  it('is the neutral element of multiply on both sides', () => {
    const m: Matrix2D = [2, 3, 4, 5, 6, 7];
    expectMatrixClose(multiply(m, IDENTITY), m);
    expectMatrixClose(multiply(IDENTITY, m), m);
  });
});

describe('applyToPoint', () => {
  it('matches the hand-expanded x = a*x + c*y + e, y = b*x + d*y + f', () => {
    const m: Matrix2D = [2, 3, 4, 5, 6, 7];
    // x' = 2*10 + 4*100 + 6 = 426 ; y' = 3*10 + 5*100 + 7 = 537
    expect(applyToPoint(m, { x: 10, y: 100 })).toEqual({ x: 426, y: 537 });
  });

  it('translation moves, scale scales', () => {
    expect(applyToPoint(fromTranslation(5, -2), { x: 1, y: 1 })).toEqual({ x: 6, y: -1 });
    expect(applyToPoint(fromScale(3, 0.5), { x: 2, y: 8 })).toEqual({ x: 6, y: 4 });
  });
});

describe('fromRotation', () => {
  it('takes +x to +y at a quarter turn (y-down screen axes)', () => {
    const point = applyToPoint(fromRotation(Math.PI / 2), { x: 1, y: 0 });
    expect(point.x).toBeCloseTo(0, PRECISION);
    expect(point.y).toBeCloseTo(1, PRECISION);
  });

  it('composes additively: R(a)·R(b) === R(a+b)', () => {
    expectMatrixClose(multiply(fromRotation(0.4), fromRotation(0.9)), fromRotation(1.3));
  });

  it('four quarter turns is the identity', () => {
    const quarter = fromRotation(Math.PI / 2);
    expectMatrixClose(multiply(multiply(quarter, quarter), multiply(quarter, quarter)), IDENTITY);
  });
});

describe('multiply order', () => {
  it('applies the right-hand matrix first', () => {
    // Rotate a quarter turn, then translate: the translation is NOT rotated.
    const rotateThenTranslate = multiply(fromTranslation(10, 0), fromRotation(Math.PI / 2));
    const result = applyToPoint(rotateThenTranslate, { x: 1, y: 0 });
    expect(result.x).toBeCloseTo(10, PRECISION);
    expect(result.y).toBeCloseTo(1, PRECISION);

    // The other order rotates the translation with the point.
    const translateThenRotate = multiply(fromRotation(Math.PI / 2), fromTranslation(10, 0));
    const other = applyToPoint(translateThenRotate, { x: 1, y: 0 });
    expect(other.x).toBeCloseTo(0, PRECISION);
    expect(other.y).toBeCloseTo(11, PRECISION);
  });

  it('compose() reads left-to-right and agrees with nested multiply', () => {
    const a = fromTranslation(3, 4);
    const b = fromRotation(0.6);
    const c = fromScale(2, 2);
    // compose(a, b, c) = "a then b then c" = c · b · a
    expectMatrixClose(compose(a, b, c), multiply(c, multiply(b, a)));
  });
});

describe('invert', () => {
  it('round-trips to the identity', () => {
    const m = compose(fromTranslation(12, -4), fromRotation(0.83), fromScale(2, 3));
    const inverse = invert(m);
    expect(inverse).not.toBeNull();
    if (inverse === null) return;
    expectMatrixClose(multiply(m, inverse), IDENTITY);
    expectMatrixClose(multiply(inverse, m), IDENTITY);
  });

  it('round-trips a point through transform and inverse', () => {
    const m = compose(fromTranslation(-40, 7), fromRotation(-1.2), fromScale(0.25, 4));
    const inverse = invert(m);
    expect(inverse).not.toBeNull();
    if (inverse === null) return;
    const original = { x: 17, y: -3 };
    const back = applyToPoint(inverse, applyToPoint(m, original));
    expect(back.x).toBeCloseTo(original.x, PRECISION);
    expect(back.y).toBeCloseTo(original.y, PRECISION);
  });

  it('returns null on a singular matrix rather than throwing', () => {
    expect(invert(fromScale(0, 1))).toBeNull();
    expect(invert(fromScale(1, 0))).toBeNull();
    // Collinear columns: determinant zero even though no entry is.
    expect(invert([1, 2, 2, 4, 0, 0])).toBeNull();
  });

  it('refuses a near-singular matrix instead of returning huge entries', () => {
    expect(invert(fromScale(1e-7, 1e-7))).toBeNull();
  });
});

describe('elementMatrix', () => {
  it('is a plain translation when unrotated', () => {
    expectMatrixClose(elementMatrix(rect({ x: 30, y: 12 })), fromTranslation(30, 12));
  });

  it('maps local corners to the element rect when unrotated', () => {
    const element = rect({ x: 30, y: 12, width: 100, height: 40 });
    const m = elementMatrix(element);
    expect(applyToPoint(m, { x: 0, y: 0 })).toEqual({ x: 30, y: 12 });
    expect(applyToPoint(m, { x: 100, y: 40 })).toEqual({ x: 130, y: 52 });
  });

  it('rotates about the element centre - hand-computed quarter turn', () => {
    // x=10, y=20, w=100, h=40 → centre (60, 40).
    // Local (0,0) is the top-left, offset (-50, -20) from the centre.
    // A quarter turn sends (dx, dy) → (-dy, dx) = (20, -50).
    // Adding the centre back: (80, -10).
    const element = rect({ x: 10, y: 20, width: 100, height: 40, rotation: Math.PI / 2 });
    const topLeft = applyToPoint(elementMatrix(element), { x: 0, y: 0 });
    expect(topLeft.x).toBeCloseTo(80, PRECISION);
    expect(topLeft.y).toBeCloseTo(-10, PRECISION);
  });

  it('holds the centre fixed at any rotation', () => {
    const element = rect({ x: 10, y: 20, width: 100, height: 40, rotation: 1.1 });
    const center = applyToPoint(elementMatrix(element), { x: 50, y: 20 });
    expect(center.x).toBeCloseTo(60, PRECISION);
    expect(center.y).toBeCloseTo(40, PRECISION);
  });

  it('preserves lengths - it is a rigid motion, never a scale', () => {
    const element = rect({ x: 3, y: 9, width: 100, height: 40, rotation: 0.77 });
    const m = elementMatrix(element);
    const a = applyToPoint(m, { x: 0, y: 0 });
    const b = applyToPoint(m, { x: 30, y: 40 });
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(50, PRECISION);
  });
});

describe('inverseElementMatrix', () => {
  it('takes a world point back to local space', () => {
    const element = rect({ x: 10, y: 20, width: 100, height: 40, rotation: Math.PI / 2 });
    const inverse = inverseElementMatrix(element);
    expect(inverse).not.toBeNull();
    if (inverse === null) return;
    const local = applyToPoint(inverse, { x: 80, y: -10 });
    expect(local.x).toBeCloseTo(0, PRECISION);
    expect(local.y).toBeCloseTo(0, PRECISION);
  });

  it('is still invertible for a zero-area element, because it has no scale term', () => {
    // The element matrix is translate ∘ rotate only, so a collapsed element
    // still has determinant 1 - width/height never enter the linear part.
    expect(inverseElementMatrix(rect({ width: 0, height: 0 }))).not.toBeNull();
  });
});
