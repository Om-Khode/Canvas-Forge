import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  defaultViewport,
  screenDeltaToWorld,
  screenPoint,
  screenToWorld,
  viewportToFit,
  visibleWorldRect,
  worldPoint,
  worldToScreen,
  zoomAroundPoint,
} from './coords';
import { MAX_ZOOM, MIN_ZOOM } from '@/constants/canvas';
import type { Viewport } from '@/types';

const viewport: Viewport = { panX: 120, panY: -40, zoom: 2.5 };

describe('screen ↔ world conversion', () => {
  it('applies scale then pan going world → screen', () => {
    expect(worldToScreen(worldPoint(10, 10), viewport)).toEqual({ x: 145, y: -15 });
  });

  it('round-trips any point through both directions', () => {
    for (const [x, y] of [
      [0, 0],
      [1234.5, -987.25],
      [-1e6, 1e6],
    ] as const) {
      const result = worldToScreen(screenToWorld(screenPoint(x, y), viewport), viewport);
      expect(result.x).toBeCloseTo(x, 6);
      expect(result.y).toBeCloseTo(y, 6);
    }
  });

  it('scales a delta without applying pan', () => {
    // The bug this guards: dragging works at 100% zoom and drifts at any other.
    expect(screenDeltaToWorld(50, 25, viewport)).toEqual({ x: 20, y: 10 });
  });
});

describe('zoomAroundPoint', () => {
  it('keeps the world point under the cursor fixed on screen', () => {
    const cursor = screenPoint(300, 200);
    const anchorBefore = screenToWorld(cursor, viewport);

    const next = zoomAroundPoint(viewport, cursor, viewport.zoom * 1.8);
    const anchorAfter = screenToWorld(cursor, next);

    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 9);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 9);
  });

  it('holds the anchor fixed even when the requested zoom is clamped', () => {
    const cursor = screenPoint(64, 64);
    const anchorBefore = screenToWorld(cursor, viewport);

    const next = zoomAroundPoint(viewport, cursor, MAX_ZOOM * 100);

    expect(next.zoom).toBe(MAX_ZOOM);
    const anchorAfter = screenToWorld(cursor, next);
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 9);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 9);
  });
});

describe('clampZoom', () => {
  it('bounds the zoom to the configured range', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe('visibleWorldRect', () => {
  it('describes exactly the region the viewport shows', () => {
    const rect = visibleWorldRect(800, 600, { panX: 0, panY: 0, zoom: 2 });
    expect(rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('accounts for pan', () => {
    const rect = visibleWorldRect(800, 600, { panX: -200, panY: -100, zoom: 1 });
    expect(rect.x).toBe(200);
    expect(rect.y).toBe(100);
  });
});

describe('viewportToFit', () => {
  it('centres the content in the viewport', () => {
    const content = { x: 100, y: 100, width: 200, height: 200 };
    const fitted = viewportToFit(content, 1000, 1000, 0.1);

    const center = worldToScreen(worldPoint(200, 200), fitted);
    expect(center.x).toBeCloseTo(500, 6);
    expect(center.y).toBeCloseTo(500, 6);
  });

  it('leaves the requested padding around the content', () => {
    const content = { x: 0, y: 0, width: 100, height: 100 };
    const fitted = viewportToFit(content, 1000, 500, 0.1);

    // Limited by the shorter axis: 500 * 0.8 / 100 = 4.
    expect(fitted.zoom).toBeCloseTo(4, 6);
  });

  it('falls back to a centred identity view for empty content', () => {
    const fitted = viewportToFit({ x: 0, y: 0, width: 0, height: 0 }, 800, 600);
    expect(fitted).toEqual(defaultViewport(800, 600));
  });
});
