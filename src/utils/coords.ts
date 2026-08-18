/**
 * The one place screen coordinates become world coordinates and back.
 *
 * Nothing else in the codebase may write `(clientX - panX) / zoom`. Centralising
 * it means the transform can be changed (device pixel ratio, a rotated canvas,
 * a different origin convention) in a single file, and it's the only place the
 * ScreenPoint/WorldPoint brands are applied or stripped.
 *
 * The transform:
 *     screen = world * zoom + pan
 *     world  = (screen - pan) / zoom
 */

import { MAX_ZOOM, MIN_ZOOM, ZOOM_TO_FIT_PADDING } from '@/constants/canvas';
import type {
  Rect,
  ScreenPoint,
  ScreenRect,
  Vec2,
  Viewport,
  WorldPoint,
  WorldRect,
  WorldVector,
} from '@/types';

/* ---------------------------------------------------------------- brands -- */

export function screenPoint(x: number, y: number): ScreenPoint {
  return { x, y } as ScreenPoint;
}

export function worldPoint(x: number, y: number): WorldPoint {
  return { x, y } as WorldPoint;
}

export function worldVector(x: number, y: number): WorldVector {
  return { x, y } as WorldVector;
}

export function worldRect(x: number, y: number, width: number, height: number): WorldRect {
  return { x, y, width, height } as WorldRect;
}

export function screenRect(x: number, y: number, width: number, height: number): ScreenRect {
  return { x, y, width, height } as ScreenRect;
}

/** Drops the brand. For handing a point to code that is space-agnostic (drawing, maths). */
export function toVec2(point: ScreenPoint | WorldPoint | WorldVector): Vec2 {
  return { x: point.x, y: point.y };
}

/* ------------------------------------------------------------ conversion -- */

export function screenToWorld(point: ScreenPoint, viewport: Viewport): WorldPoint {
  return worldPoint((point.x - viewport.panX) / viewport.zoom, (point.y - viewport.panY) / viewport.zoom);
}

export function worldToScreen(point: WorldPoint, viewport: Viewport): ScreenPoint {
  return screenPoint(point.x * viewport.zoom + viewport.panX, point.y * viewport.zoom + viewport.panY);
}

/**
 * Converts a *displacement*, not a position - so the pan offset must not be
 * applied. Getting this wrong is a classic bug: dragging works at 100% zoom
 * and drifts everywhere else.
 */
export function screenDeltaToWorld(dx: number, dy: number, viewport: Viewport): WorldVector {
  return worldVector(dx / viewport.zoom, dy / viewport.zoom);
}

/** A length in screen pixels expressed in world units - for zoom-invariant hit tolerances. */
export function screenLengthToWorld(lengthPx: number, viewport: Viewport): number {
  return lengthPx / viewport.zoom;
}

/**
 * Pointer event to canvas-relative screen point.
 *
 * `clientX/Y` are viewport-relative; the canvas may be inset by panels and the
 * page may be scrolled, so the element's bounding rect has to be subtracted.
 */
export function eventToScreenPoint(
  event: { readonly clientX: number; readonly clientY: number },
  canvasBounds: DOMRect
): ScreenPoint {
  return screenPoint(event.clientX - canvasBounds.left, event.clientY - canvasBounds.top);
}

export function worldRectToScreen(rect: WorldRect, viewport: Viewport): ScreenRect {
  const topLeft = worldToScreen(worldPoint(rect.x, rect.y), viewport);
  return screenRect(topLeft.x, topLeft.y, rect.width * viewport.zoom, rect.height * viewport.zoom);
}

export function screenRectToWorld(rect: ScreenRect, viewport: Viewport): WorldRect {
  const topLeft = screenToWorld(screenPoint(rect.x, rect.y), viewport);
  return worldRect(topLeft.x, topLeft.y, rect.width / viewport.zoom, rect.height / viewport.zoom);
}

/* ------------------------------------------------------------------ zoom -- */

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Zoom while holding one screen point fixed over the same world point.
 *
 * Naïve zoom scales about the world origin, which sends content flying off
 * screen. The invariant we want is:
 *
 *     worldToScreen(anchorWorld, after) === anchorScreen
 *
 * Substituting the forward transform and solving for pan gives the two lines
 * below. Everything else - wheel zoom, pinch zoom, the +/- buttons, zoom to
 * fit - is this function with a different anchor.
 */
export function zoomAroundPoint(
  viewport: Viewport,
  anchorScreen: ScreenPoint,
  nextZoomRaw: number
): Viewport {
  const nextZoom = clampZoom(nextZoomRaw);
  const anchorWorld = screenToWorld(anchorScreen, viewport);
  return {
    zoom: nextZoom,
    panX: anchorScreen.x - anchorWorld.x * nextZoom,
    panY: anchorScreen.y - anchorWorld.y * nextZoom,
  };
}

/** Wheel delta to a zoom factor. Exponential so each notch feels equal at any zoom. */
export function wheelDeltaToZoomFactor(deltaY: number, sensitivity: number): number {
  return Math.exp(-deltaY * sensitivity);
}

/**
 * The world-space rectangle currently visible. Used to cull elements before
 * drawing, which is what keeps frame cost proportional to what's on screen
 * rather than to document size.
 */
export function visibleWorldRect(
  viewportWidthPx: number,
  viewportHeightPx: number,
  viewport: Viewport
): WorldRect {
  const topLeft = screenToWorld(screenPoint(0, 0), viewport);
  return worldRect(
    topLeft.x,
    topLeft.y,
    viewportWidthPx / viewport.zoom,
    viewportHeightPx / viewport.zoom
  );
}

/**
 * A viewport that frames `content` inside the given screen size with padding.
 * An empty document has no meaningful frame, so the caller passes a fallback.
 */
export function viewportToFit(
  content: Rect,
  viewportWidthPx: number,
  viewportHeightPx: number,
  padding = ZOOM_TO_FIT_PADDING
): Viewport {
  if (content.width <= 0 || content.height <= 0) {
    return { panX: viewportWidthPx / 2, panY: viewportHeightPx / 2, zoom: 1 };
  }

  const usableWidth = viewportWidthPx * (1 - padding * 2);
  const usableHeight = viewportHeightPx * (1 - padding * 2);
  const zoom = clampZoom(Math.min(usableWidth / content.width, usableHeight / content.height));

  // Centre the content's centre in the viewport's centre.
  const contentCenterX = content.x + content.width / 2;
  const contentCenterY = content.y + content.height / 2;

  return {
    zoom,
    panX: viewportWidthPx / 2 - contentCenterX * zoom,
    panY: viewportHeightPx / 2 - contentCenterY * zoom,
  };
}

/** Centres the world origin in the viewport at 100%. The "reset view" target. */
export function defaultViewport(viewportWidthPx: number, viewportHeightPx: number): Viewport {
  return { panX: viewportWidthPx / 2, panY: viewportHeightPx / 2, zoom: 1 };
}
