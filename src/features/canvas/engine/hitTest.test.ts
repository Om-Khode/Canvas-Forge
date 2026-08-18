import { describe, expect, it } from 'vitest';
import { STROKE_HIT_TOLERANCE_PX } from '@/constants';
import { pointerEligibility } from '@/features/selection/resolve';
import type {
  ArrowElement,
  CanvasElement,
  EllipseElement,
  ElementStore,
  FreehandElement,
  GroupElement,
  RectangleElement,
  TextElement,
  Viewport,
} from '@/types';
import { worldPoint } from '@/utils/coords';
import { hitTestPoint, hitTestRect, isPickable } from './hitTest';

const VIEWPORT: Viewport = { panX: 0, panY: 0, zoom: 1 };

function base(id: string) {
  return {
    id,
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
  } as const;
}

function rect(id: string, overrides: Partial<RectangleElement> = {}): RectangleElement {
  return {
    ...base(id),
    type: 'rectangle',
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 2,
    strokeStyle: 'solid',
    cornerRadius: 0,
    ...overrides,
  };
}

function ellipse(id: string, overrides: Partial<EllipseElement> = {}): EllipseElement {
  return {
    ...base(id),
    type: 'ellipse',
    width: 100,
    height: 100,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 2,
    strokeStyle: 'solid',
    ...overrides,
  };
}

function arrow(id: string, overrides: Partial<ArrowElement> = {}): ArrowElement {
  return {
    ...base(id),
    type: 'arrow',
    stroke: '#000',
    strokeWidth: 1,
    strokeStyle: 'solid',
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
    arrowheadStart: 'none',
    arrowheadEnd: 'triangle',
    ...overrides,
  };
}

function freehand(id: string, overrides: Partial<FreehandElement> = {}): FreehandElement {
  return {
    ...base(id),
    type: 'freehand',
    stroke: '#000',
    strokeWidth: 1,
    strokeStyle: 'solid',
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 0 },
    ],
    ...overrides,
  };
}

function text(id: string, overrides: Partial<TextElement> = {}): TextElement {
  return {
    ...base(id),
    type: 'text',
    text: 'hello',
    fontFamily: 'sans-serif',
    fontSize: 16,
    fontWeight: 400,
    italic: false,
    textAlign: 'left',
    lineHeight: 1.35,
    color: '#000',
    autoHeight: true,
    ...overrides,
  };
}

function group(id: string, childIds: string[], overrides: Partial<GroupElement> = {}): GroupElement {
  return {
    ...base(id),
    type: 'group',
    childIds,
    ...overrides,
  };
}

function store(elements: CanvasElement[], order: string[]): ElementStore {
  return { byId: Object.fromEntries(elements.map((e) => [e.id, e])), order };
}

describe('isPickable', () => {
  it('rejects hidden and locked elements', () => {
    expect(isPickable(rect('a'))).toBe(true);
    expect(isPickable(rect('a', { visible: false }))).toBe(false);
    expect(isPickable(rect('a', { locked: true }))).toBe(false);
  });
});

describe('hitTestPoint - ordering and filtering', () => {
  it('returns the topmost element, since input is bottom-to-top', () => {
    const bottom = rect('bottom');
    const top = rect('top');
    expect(hitTestPoint(worldPoint(50, 20), [bottom, top], VIEWPORT)?.id).toBe('top');
  });

  it('falls through hidden and locked elements to what is beneath them', () => {
    const bottom = rect('bottom');
    const hidden = rect('hidden', { visible: false });
    const locked = rect('locked', { locked: true });
    expect(hitTestPoint(worldPoint(50, 20), [bottom, hidden, locked], VIEWPORT)?.id).toBe('bottom');
  });

  it('returns null when nothing is under the point', () => {
    expect(hitTestPoint(worldPoint(500, 500), [rect('a')], VIEWPORT)).toBeNull();
  });

  it('declines a member of a hidden group via the isEligible predicate, and falls through to what is beneath it', () => {
    // `isPickable` only sees the member's own flags - visible, not locked - so
    // without the predicate this hit test would happily pick it. The veto for
    // a hidden or locked *ancestor* comes entirely from `pointerEligibility`,
    // which is the one argument standing between this call and that regression.
    const member = rect('member');
    const hiddenGroup = group('hiddenGroup', ['member'], { visible: false });
    const bottom = rect('bottom');
    const elements = store([bottom, hiddenGroup, member], ['bottom', 'hiddenGroup']);

    expect(
      hitTestPoint(worldPoint(50, 20), [bottom, member], VIEWPORT, pointerEligibility(elements))
        ?.id
    ).toBe('bottom');
  });
});

describe('hitTestPoint - rotated rectangles', () => {
  /*
   * A 200x40 bar at the origin, rotated a quarter turn about its centre (100, 20).
   * After rotation it occupies x ∈ [80, 120], y ∈ [-80, 120].
   *
   * The two assertions below are the whole point of testing in local space: a
   * naive implementation that tests the unrotated box gets both backwards.
   */
  const bar = rect('bar', { width: 200, height: 40, rotation: Math.PI / 2 });

  it('misses a point that is inside the unrotated box but outside the rotated one', () => {
    // (150, 20) is well within [0,200]x[0,40] but 30 units past the rotated
    // right edge at x = 120 - far outside the hit tolerance.
    expect(hitTestPoint(worldPoint(150, 20), [bar], VIEWPORT)).toBeNull();
  });

  it('hits a point that is outside the unrotated box but inside the rotated one', () => {
    // (100, 100) is 60 units below the unrotated bottom edge at y = 40, and
    // comfortably inside the rotated extent.
    expect(hitTestPoint(worldPoint(100, 100), [bar], VIEWPORT)?.id).toBe('bar');
  });

  it('still hits the shared centre, which rotation leaves fixed', () => {
    expect(hitTestPoint(worldPoint(100, 20), [bar], VIEWPORT)?.id).toBe('bar');
  });

  it('an arbitrary angle hits along the rotated axis, not the world axis', () => {
    const tilted = rect('tilted', { width: 200, height: 10, rotation: Math.PI / 4 });
    // Centre (100, 5); the long axis now runs at 45°, so a point 60 units along
    // that diagonal is on the shape.
    const along = 60 / Math.SQRT2;
    expect(hitTestPoint(worldPoint(100 + along, 5 + along), [tilted], VIEWPORT)?.id).toBe('tilted');
    // The same distance along the world x axis is off the end of the bar.
    expect(hitTestPoint(worldPoint(100 + 60, 5), [tilted], VIEWPORT)).toBeNull();
  });
});

describe('hitTestPoint - per-shape behaviour', () => {
  it('a hollow rectangle is clickable on its border but not through its middle', () => {
    const hollow = rect('hollow', { fill: null, strokeWidth: 2, width: 200, height: 200 });
    expect(hitTestPoint(worldPoint(0, 100), [hollow], VIEWPORT)?.id).toBe('hollow');
    expect(hitTestPoint(worldPoint(100, 100), [hollow], VIEWPORT)).toBeNull();
  });

  it('a filled ellipse rejects the corners of its bounding box', () => {
    const disc = ellipse('disc');
    expect(hitTestPoint(worldPoint(50, 50), [disc], VIEWPORT)?.id).toBe('disc');
    // (0,0) is a bbox corner: radial distance is sqrt(2) > 1 even after the
    // tolerance inflates the radii.
    expect(hitTestPoint(worldPoint(0, 0), [disc], VIEWPORT)).toBeNull();
  });

  it('a hollow ellipse is clickable on its rim only', () => {
    const ring = ellipse('ring', { fill: null, width: 200, height: 200 });
    expect(hitTestPoint(worldPoint(0, 100), [ring], VIEWPORT)?.id).toBe('ring');
    expect(hitTestPoint(worldPoint(100, 100), [ring], VIEWPORT)).toBeNull();
  });

  it('an arrow is clickable within tolerance of its shaft', () => {
    // Endpoints are normalized: (0,0) → (1,1) across a 100x40 box.
    const diagonal = arrow('diagonal');
    expect(hitTestPoint(worldPoint(50, 20), [diagonal], VIEWPORT)?.id).toBe('diagonal');
    // Perpendicular offset far beyond the tolerance band.
    expect(hitTestPoint(worldPoint(50, 20 + STROKE_HIT_TOLERANCE_PX * 4), [diagonal], VIEWPORT)).toBeNull();
  });

  it('text and images are picked as solid boxes', () => {
    const label = text('label');
    expect(hitTestPoint(worldPoint(90, 35), [label], VIEWPORT)?.id).toBe('label');
    expect(hitTestPoint(worldPoint(300, 35), [label], VIEWPORT)).toBeNull();
  });

  it('a freehand stroke is picked near its samples, not across its bounding box', () => {
    const scribble = freehand('scribble', { width: 100, height: 100 });
    // The stroke runs (0,0) → (50,100) → (100,0). Its apex region is empty.
    expect(hitTestPoint(worldPoint(50, 100), [scribble], VIEWPORT)?.id).toBe('scribble');
    expect(hitTestPoint(worldPoint(50, 10), [scribble], VIEWPORT)).toBeNull();
  });
});

describe('hitTestPoint - zoom-scaled tolerance', () => {
  const hairline = arrow('hairline', {
    strokeWidth: 1,
    start: { x: 0, y: 0.5 },
    end: { x: 1, y: 0.5 },
  });

  it('tolerance grows in world units as you zoom out', () => {
    // 20 world units off the shaft. At zoom 1 the band is ~6.5 units: a miss.
    // At zoom 0.1 the same 6.5 screen px is 60+ world units: a hit.
    const offset = worldPoint(50, 40);
    expect(hitTestPoint(offset, [hairline], VIEWPORT)).toBeNull();
    expect(hitTestPoint(offset, [hairline], { panX: 0, panY: 0, zoom: 0.1 })?.id).toBe('hairline');
  });
});

describe('hitTestRect', () => {
  const a = rect('a', { x: 0, y: 0, width: 50, height: 50 });
  const b = rect('b', { x: 200, y: 200, width: 50, height: 50 });
  const elements: CanvasElement[] = [a, b];

  it('returns overlapping elements in paint order', () => {
    const hits = hitTestRect({ x: -10, y: -10, width: 500, height: 500 }, elements);
    expect(hits.map((element) => element.id)).toEqual(['a', 'b']);
  });

  it('excludes elements outside the marquee', () => {
    const hits = hitTestRect({ x: -10, y: -10, width: 100, height: 100 }, elements);
    expect(hits.map((element) => element.id)).toEqual(['a']);
  });

  it('skips hidden and locked elements', () => {
    const hidden = rect('hidden', { visible: false });
    const locked = rect('locked', { locked: true });
    const hits = hitTestRect({ x: -1000, y: -1000, width: 4000, height: 4000 }, [hidden, locked, a]);
    expect(hits.map((element) => element.id)).toEqual(['a']);
  });

  it('uses the rotated AABB, so a tilted bar is caught outside its unrotated box', () => {
    // 200x40 bar rotated a quarter turn reaches down to y = 120.
    const bar = rect('bar', { width: 200, height: 40, rotation: Math.PI / 2 });
    const marquee = { x: 90, y: 100, width: 20, height: 20 };
    expect(hitTestRect(marquee, [bar]).map((element) => element.id)).toEqual(['bar']);
    // Unrotated, that same bar would only reach y = 40.
    const unrotated = rect('bar', { width: 200, height: 40 });
    expect(hitTestRect(marquee, [unrotated])).toEqual([]);
  });

  it('selects on overlap, not containment', () => {
    const marquee = { x: 40, y: 40, width: 20, height: 20 };
    expect(hitTestRect(marquee, [a]).map((element) => element.id)).toEqual(['a']);
  });
});
