/**
 * The dot grid.
 *
 * Drawn in **world space**, under the viewport transform, so the dots pan and
 * zoom with the content and act as a depth cue - a grid painted in screen space
 * would sit still while the artwork moved, which reads as the canvas being
 * behind glass.
 */

import { GRID_DOT_RADIUS, GRID_MIN_VISIBLE_ZOOM, GRID_SIZE } from '@/constants';
import type { Rect, Viewport } from '@/types';
import type { CanvasTheme } from './theme';

/**
 * Hard ceiling on dots per frame.
 *
 * `GRID_MIN_VISIBLE_ZOOM` already keeps the density sane for a normal viewport,
 * but nothing bounds the *size* a caller may pass - a PNG export at 8× scale
 * covers a far larger world rect than a screen does. This stops one export
 * request from queueing a million arcs.
 */
const MAX_DOTS = 20_000;

export function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  visibleWorld: Rect,
  viewport: Viewport,
  theme: CanvasTheme
): void {
  // Below this the spacing approaches the dot diameter: thousands of draw calls
  // to produce a flat grey wash. Dropping the grid is both faster and clearer.
  if (viewport.zoom < GRID_MIN_VISIBLE_ZOOM) return;

  // The radius is specified in *screen* pixels but drawn under a transform
  // scaled by zoom, so it is divided by zoom to come out the same size on
  // screen at every zoom level. Without this the dots become blobs when you
  // zoom in and vanish when you zoom out.
  const radiusWorld = GRID_DOT_RADIUS / viewport.zoom;

  // Snap the start of the loop down to the first grid multiple at or before the
  // visible edge, so the lattice is anchored to the world origin rather than to
  // wherever the camera happens to be - otherwise the dots crawl while panning.
  const startX = Math.floor(visibleWorld.x / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(visibleWorld.y / GRID_SIZE) * GRID_SIZE;
  const endX = visibleWorld.x + visibleWorld.width;
  const endY = visibleWorld.y + visibleWorld.height;

  const columns = Math.floor((endX - startX) / GRID_SIZE) + 1;
  const rows = Math.floor((endY - startY) / GRID_SIZE) + 1;
  if (columns <= 0 || rows <= 0 || columns * rows > MAX_DOTS) return;

  // One path, one fill. Filling per dot would be `columns * rows` state changes
  // and rasterizer flushes; batching them is the difference between a grid that
  // costs ~0.1ms and one that shows up in a profile.
  ctx.fillStyle = theme.dot;
  ctx.beginPath();
  for (let column = 0; column < columns; column += 1) {
    const x = startX + column * GRID_SIZE;
    for (let row = 0; row < rows; row += 1) {
      const y = startY + row * GRID_SIZE;
      ctx.moveTo(x + radiusWorld, y);
      ctx.arc(x, y, radiusWorld, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}
