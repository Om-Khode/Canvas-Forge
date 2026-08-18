import { describe, expect, it } from 'vitest';
import {
  HANDLE_HIT_PADDING_PX,
  HANDLE_SIZE_PX,
  ROTATION_HANDLE_OFFSET_PX,
} from '@/constants';
import type { TransformHandle, Viewport } from '@/types';
import { screenPoint } from '@/utils/coords';
import type { SelectionBounds } from './bounds';
import {
  RESIZE_HANDLES,
  computeSelectionHandles,
  handleScreenRect,
  hitTestHandle,
} from './handles';

const ORIGIN_VIEWPORT: Viewport = { panX: 0, panY: 0, zoom: 1 };

const UPRIGHT: SelectionBounds = {
  kind: 'multiple',
  rect: { x: 0, y: 0, width: 200, height: 100 },
  rotation: 0,
  count: 2,
};

function centerOf(bounds: SelectionBounds, viewport: Viewport, handle: TransformHandle) {
  const set = computeSelectionHandles(bounds, viewport);
  if (set === null) throw new Error('expected a handle set');
  const target = set.handles.find((candidate) => candidate.handle === handle);
  if (target === undefined) throw new Error(`missing handle ${handle}`);
  return target.center;
}

describe('computeSelectionHandles', () => {
  it('returns null for an empty selection', () => {
    expect(computeSelectionHandles({ kind: 'none' }, ORIGIN_VIEWPORT)).toBeNull();
  });

  it('produces eight resize handles plus one rotation handle', () => {
    const set = computeSelectionHandles(UPRIGHT, ORIGIN_VIEWPORT);
    if (set === null) throw new Error('expected a handle set');
    expect(set.handles).toHaveLength(9);
    expect(new Set(set.handles.map((target) => target.handle))).toEqual(
      new Set<TransformHandle>([...RESIZE_HANDLES, 'rotate'])
    );
  });

  it('places resize handles on the box corners and edge midpoints', () => {
    expect(centerOf(UPRIGHT, ORIGIN_VIEWPORT, 'nw')).toMatchObject({ x: 0, y: 0 });
    expect(centerOf(UPRIGHT, ORIGIN_VIEWPORT, 'se')).toMatchObject({ x: 200, y: 100 });
    expect(centerOf(UPRIGHT, ORIGIN_VIEWPORT, 'n')).toMatchObject({ x: 100, y: 0 });
    expect(centerOf(UPRIGHT, ORIGIN_VIEWPORT, 'w')).toMatchObject({ x: 0, y: 50 });
  });

  it('applies pan and zoom to handle positions', () => {
    const viewport: Viewport = { panX: 30, panY: -10, zoom: 2 };
    // world (200, 100) → screen (200*2 + 30, 100*2 - 10)
    expect(centerOf(UPRIGHT, viewport, 'se')).toMatchObject({ x: 430, y: 190 });
  });

  it('exposes the four rotated corners for the outline', () => {
    const set = computeSelectionHandles(UPRIGHT, ORIGIN_VIEWPORT);
    if (set === null) throw new Error('expected a handle set');
    expect(set.corners.map((corner) => [corner.x, corner.y])).toEqual([
      [0, 0],
      [200, 0],
      [200, 100],
      [0, 100],
    ]);
  });
});

describe('handles are screen-space and therefore zoom-invariant', () => {
  it('the painted square is HANDLE_SIZE_PX at every zoom', () => {
    for (const zoom of [0.02, 0.5, 1, 8, 64]) {
      const set = computeSelectionHandles(UPRIGHT, { panX: 0, panY: 0, zoom });
      if (set === null) throw new Error('expected a handle set');
      for (const target of set.handles) {
        const rect = handleScreenRect(target);
        expect(rect.width).toBe(HANDLE_SIZE_PX);
        expect(rect.height).toBe(HANDLE_SIZE_PX);
      }
    }
  });

  it('the painted square is centred on the handle position', () => {
    const set = computeSelectionHandles(UPRIGHT, ORIGIN_VIEWPORT);
    if (set === null) throw new Error('expected a handle set');
    const target = set.handles[0];
    if (target === undefined) throw new Error('expected a handle');
    const rect = handleScreenRect(target);
    expect(rect.x + rect.width / 2).toBeCloseTo(target.center.x, 12);
    expect(rect.y + rect.height / 2).toBeCloseTo(target.center.y, 12);
  });

  it('the rotation handle sits exactly ROTATION_HANDLE_OFFSET_PX from the top edge at any zoom', () => {
    for (const zoom of [0.05, 1, 32]) {
      const viewport: Viewport = { panX: 17, panY: -4, zoom };
      const north = centerOf(UPRIGHT, viewport, 'n');
      const rotate = centerOf(UPRIGHT, viewport, 'rotate');
      expect(Math.hypot(rotate.x - north.x, rotate.y - north.y)).toBeCloseTo(
        ROTATION_HANDLE_OFFSET_PX,
        10
      );
      // Above the box in screen terms, regardless of how zoomed in we are.
      expect(rotate.y).toBeLessThan(north.y);
    }
  });

  it('the grab target keeps its padding at every zoom', () => {
    const reach = HANDLE_SIZE_PX / 2 + HANDLE_HIT_PADDING_PX;
    for (const zoom of [0.1, 1, 16]) {
      const viewport: Viewport = { panX: 0, panY: 0, zoom };
      const set = computeSelectionHandles(UPRIGHT, viewport);
      const se = centerOf(UPRIGHT, viewport, 'se');
      // Just inside the padded box.
      expect(hitTestHandle(screenPoint(se.x + reach - 0.5, se.y), set)).toBe('se');
      // Just outside it.
      expect(hitTestHandle(screenPoint(se.x + reach + 1, se.y + reach + 1), set)).toBeNull();
    }
  });
});

describe('rotated single selection', () => {
  const TILTED: SelectionBounds = {
    kind: 'single',
    id: 'a',
    rect: { x: 0, y: 0, width: 200, height: 100 },
    rotation: Math.PI / 2,
  };

  it('rotates the handles with the box, so they hug a tilted shape', () => {
    // Centre (100, 50). A quarter turn sends the nw corner offset (-100, -50)
    // to (50, -100), i.e. world (150, -50).
    const nw = centerOf(TILTED, ORIGIN_VIEWPORT, 'nw');
    expect(nw.x).toBeCloseTo(150, 9);
    expect(nw.y).toBeCloseTo(-50, 9);
  });

  it('offsets the rotation handle along the selection’s own up axis', () => {
    const north = centerOf(TILTED, ORIGIN_VIEWPORT, 'n');
    const rotate = centerOf(TILTED, ORIGIN_VIEWPORT, 'rotate');
    // Up for a quarter-turned box is world +x, so the handle moves right, not up.
    expect(rotate.x - north.x).toBeCloseTo(ROTATION_HANDLE_OFFSET_PX, 9);
    expect(rotate.y - north.y).toBeCloseTo(0, 9);
  });
});

describe('hitTestHandle', () => {
  const set = computeSelectionHandles(UPRIGHT, ORIGIN_VIEWPORT);

  it('returns null for a null handle set', () => {
    expect(hitTestHandle(screenPoint(0, 0), null)).toBeNull();
  });

  it('hits dead centre', () => {
    expect(hitTestHandle(screenPoint(200, 100), set)).toBe('se');
    expect(hitTestHandle(screenPoint(100, 0), set)).toBe('n');
  });

  it('hits the rotation handle above the box', () => {
    expect(hitTestHandle(screenPoint(100, -ROTATION_HANDLE_OFFSET_PX), set)).toBe('rotate');
  });

  it('misses the middle of the selection', () => {
    expect(hitTestHandle(screenPoint(100, 50), set)).toBeNull();
  });

  it('prefers a corner over an edge where the two targets overlap', () => {
    // A selection small enough that 'nw' and 'n' grab boxes overlap.
    const tiny: SelectionBounds = {
      kind: 'multiple',
      rect: { x: 0, y: 0, width: 4, height: 4 },
      rotation: 0,
      count: 2,
    };
    const tinySet = computeSelectionHandles(tiny, ORIGIN_VIEWPORT);
    expect(hitTestHandle(screenPoint(1, 0), tinySet)).toBe('nw');
  });
});
