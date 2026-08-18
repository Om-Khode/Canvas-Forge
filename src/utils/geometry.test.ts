import { describe, expect, it } from 'vitest';
import {
  distancePointToSegment,
  expandRect,
  normalizeRect,
  rectCenter,
  rectContainsPoint,
  rectContainsRect,
  rectFromPoints,
  rectsIntersect,
  rotatePoint,
  rotatedBounds,
  unionRects,
} from './geometry';

const EPSILON = 1e-9;

describe('normalizeRect', () => {
  it('leaves a positive rect untouched', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(normalizeRect(rect)).toEqual(rect);
  });

  it('flips a rect dragged up and to the left', () => {
    expect(normalizeRect({ x: 10, y: 10, width: -4, height: -6 })).toEqual({
      x: 6,
      y: 4,
      width: 4,
      height: 6,
    });
  });
});

describe('rectFromPoints', () => {
  it('spans two corners regardless of drag direction', () => {
    const forward = rectFromPoints({ x: 0, y: 0 }, { x: 10, y: 5 });
    const backward = rectFromPoints({ x: 10, y: 5 }, { x: 0, y: 0 });
    expect(forward).toEqual({ x: 0, y: 0, width: 10, height: 5 });
    expect(backward).toEqual(forward);
  });
});

describe('rectsIntersect', () => {
  const base = { x: 0, y: 0, width: 10, height: 10 };

  it('detects overlap', () => {
    expect(rectsIntersect(base, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
  });

  it('treats touching edges as intersecting, so edge-flush elements survive culling', () => {
    expect(rectsIntersect(base, { x: 10, y: 0, width: 5, height: 5 })).toBe(true);
  });

  it('rejects separation on either axis alone', () => {
    expect(rectsIntersect(base, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
    expect(rectsIntersect(base, { x: 0, y: 11, width: 5, height: 5 })).toBe(false);
  });

  it('is symmetric', () => {
    const other = { x: -5, y: -5, width: 7, height: 7 };
    expect(rectsIntersect(base, other)).toBe(rectsIntersect(other, base));
  });
});

describe('rectContainsPoint / rectContainsRect', () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };

  it('includes the border', () => {
    expect(rectContainsPoint(rect, { x: 0, y: 10 })).toBe(true);
  });

  it('excludes points outside', () => {
    expect(rectContainsPoint(rect, { x: 10.1, y: 5 })).toBe(false);
  });

  it('containment requires every edge to be inside', () => {
    expect(rectContainsRect(rect, { x: 1, y: 1, width: 8, height: 8 })).toBe(true);
    expect(rectContainsRect(rect, { x: 1, y: 1, width: 20, height: 8 })).toBe(false);
  });
});

describe('unionRects', () => {
  it('returns null for an empty list rather than a zero rect', () => {
    expect(unionRects([])).toBeNull();
  });

  it('spans every input', () => {
    expect(
      unionRects([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: -5, y: 20, width: 5, height: 5 },
      ])
    ).toEqual({ x: -5, y: 0, width: 15, height: 25 });
  });

  it('is the identity on a single rect', () => {
    const rect = { x: 3, y: 4, width: 5, height: 6 };
    expect(unionRects([rect])).toEqual(rect);
  });
});

describe('rectCenter / expandRect', () => {
  it('finds the centre', () => {
    expect(rectCenter({ x: 0, y: 0, width: 10, height: 20 })).toEqual({ x: 5, y: 10 });
  });

  it('grows on all four sides', () => {
    expect(expandRect({ x: 0, y: 0, width: 10, height: 10 }, 2)).toEqual({
      x: -2,
      y: -2,
      width: 14,
      height: 14,
    });
  });

  it('floors extents at zero when over-shrunk instead of inverting', () => {
    const shrunk = expandRect({ x: 0, y: 0, width: 4, height: 4 }, -10);
    expect(shrunk.width).toBe(0);
    expect(shrunk.height).toBe(0);
  });
});

describe('rotatePoint', () => {
  it('is a no-op at zero radians', () => {
    expect(rotatePoint({ x: 3, y: 7 }, { x: 0, y: 0 }, 0)).toEqual({ x: 3, y: 7 });
  });

  it('takes +x to +y at a quarter turn (y-down axes)', () => {
    const result = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(result.x).toBeCloseTo(0, 12);
    expect(result.y).toBeCloseTo(1, 12);
  });

  it('rotates about an arbitrary pivot', () => {
    const result = rotatePoint({ x: 10, y: 5 }, { x: 5, y: 5 }, Math.PI);
    expect(result.x).toBeCloseTo(0, 12);
    expect(result.y).toBeCloseTo(5, 12);
  });

  it('four quarter turns return the original point', () => {
    let point = { x: 8, y: -3 };
    const pivot = { x: 2, y: 2 };
    for (let i = 0; i < 4; i += 1) point = rotatePoint(point, pivot, Math.PI / 2);
    expect(point.x).toBeCloseTo(8, 10);
    expect(point.y).toBeCloseTo(-3, 10);
  });
});

describe('rotatedBounds', () => {
  const rect = { x: 0, y: 0, width: 100, height: 40 };

  it('returns the rect itself when unrotated', () => {
    expect(rotatedBounds(rect, 0)).toEqual(rect);
  });

  it('treats a float-noise angle as unrotated', () => {
    expect(rotatedBounds(rect, 1e-15)).toEqual(rect);
  });

  it('swaps width and height at a quarter turn, keeping the centre fixed', () => {
    const bounds = rotatedBounds(rect, Math.PI / 2);
    expect(bounds.width).toBeCloseTo(40, 9);
    expect(bounds.height).toBeCloseTo(100, 9);
    // Centre of the original is (50, 20); rotation is about the centre.
    expect(bounds.x).toBeCloseTo(30, 9);
    expect(bounds.y).toBeCloseTo(-30, 9);
  });

  it('grows a square by sqrt(2) at 45 degrees', () => {
    const bounds = rotatedBounds({ x: 0, y: 0, width: 10, height: 10 }, Math.PI / 4);
    expect(bounds.width).toBeCloseTo(10 * Math.SQRT2, 9);
    expect(bounds.height).toBeCloseTo(10 * Math.SQRT2, 9);
  });

  it('matches the brute-force corner min/max for an arbitrary angle', () => {
    const angle = 0.7;
    const center = rectCenter(rect);
    const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ].map((corner) => rotatePoint(corner, center, angle));

    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const expected = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };

    const bounds = rotatedBounds(rect, angle);
    expect(bounds.x).toBeCloseTo(expected.x, 9);
    expect(bounds.y).toBeCloseTo(expected.y, 9);
    expect(bounds.width).toBeCloseTo(expected.width, 9);
    expect(bounds.height).toBeCloseTo(expected.height, 9);
  });

  it('is invariant under a half turn', () => {
    const quarter = rotatedBounds(rect, 0.3);
    const flipped = rotatedBounds(rect, 0.3 + Math.PI);
    expect(Math.abs(quarter.width - flipped.width)).toBeLessThan(EPSILON);
    expect(Math.abs(quarter.height - flipped.height)).toBeLessThan(EPSILON);
  });
});

describe('distancePointToSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };

  it('measures perpendicular distance in the middle', () => {
    expect(distancePointToSegment({ x: 5, y: 3 }, a, b)).toBeCloseTo(3, 12);
  });

  it('clamps past the endpoints instead of measuring to the infinite line', () => {
    // On the infinite line this would be 0; as a segment it is 5 from the end.
    expect(distancePointToSegment({ x: 15, y: 0 }, a, b)).toBeCloseTo(5, 12);
    expect(distancePointToSegment({ x: -4, y: 0 }, a, b)).toBeCloseTo(4, 12);
  });

  it('handles a degenerate segment as a point', () => {
    expect(distancePointToSegment({ x: 3, y: 4 }, a, a)).toBeCloseTo(5, 12);
  });
});
