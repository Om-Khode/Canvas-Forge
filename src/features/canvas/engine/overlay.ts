/**
 * Selection chrome: outlines, handles, marquee.
 *
 * Called with the viewport transform **reset**, so every coordinate here is a
 * CSS pixel. That is the whole reason the overlay is a separate pass rather
 * than something each drawer appends: chrome drawn under the world transform
 * would have its 1.5px outline scaled to 0.05px at 3% zoom and 48px at 3200%.
 * Converting positions to screen space and painting un-zoomed keeps the
 * furniture a constant size, which is what makes it usable at any zoom.
 *
 * This module is pure drawing - it computes no interaction state and mutates
 * nothing.
 */

import { HANDLE_SIZE_PX, SELECTION_OUTLINE_WIDTH_PX } from '@/constants';
import {
  computeSelectionHandles,
  handleScreenRect,
  type HandleTarget,
  type SelectionHandleSet,
} from '@/features/selection/handles';
import { elementRect, selectionBounds } from '@/features/selection/bounds';
import type { CanvasElement, ScreenPoint, Viewport } from '@/types';
import { screenPoint, worldPoint, worldToScreen } from '@/utils/coords';
import { rectCenter, rectFromPoints, rotatePoint } from '@/utils/geometry';
import type { RenderScene } from './scene';
import type { CanvasTheme } from './theme';

/** Alpha of the per-element outlines inside a multi-selection. */
const MEMBER_OUTLINE_ALPHA = 0.55;
const MARQUEE_FILL_ALPHA = 0.08;
const MARQUEE_DASH = [4, 3];
/** The rotation handle is a disc rather than a square, so it reads differently. */
const ROTATION_HANDLE_RADIUS = HANDLE_SIZE_PX / 2;

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  scene: RenderScene,
  theme: CanvasTheme
): void {
  drawMarquee(ctx, scene, theme);

  const selected = scene.elements.filter((element) => scene.selectedIds.has(element.id));
  if (selected.length === 0) return;

  const bounds = selectionBounds(selected);
  const set = computeSelectionHandles(bounds, scene.viewport);
  if (set === null) return;

  // With more than one element the group box is axis-aligned and says nothing
  // about where the members actually are, so each member gets a faint outline
  // of its own. With one element the group box *is* the element's box and a
  // second outline on top of it would just double the stroke weight.
  if (bounds.kind === 'multiple') {
    drawMemberOutlines(ctx, selected, scene.viewport, theme);
  }

  /*
    A locked selection is shown but not offered for transforming.

    Drawing handles you are not allowed to drag is the worst of both: it
    advertises an affordance and then refuses it. The frame stays, because the
    user still needs to see what they picked in order to unlock it or edit its
    properties - which locking is not supposed to prevent.

    The rotation stem is part of the same decision, not part of the frame: it
    exists to attach the rotation disc to the box, so without the disc it is a
    line growing out of nothing.
  */
  const transformable = selected.some((element) => !element.locked);

  drawSelectionFrame(ctx, set, theme, transformable);
  if (transformable) drawHandles(ctx, set, theme);
}

/* ---------------------------------------------------------------- marquee -- */

function drawMarquee(
  ctx: CanvasRenderingContext2D,
  scene: RenderScene,
  theme: CanvasTheme
): void {
  const { interaction, viewport } = scene;
  if (interaction.kind !== 'marquee') return;

  const origin = worldToScreen(interaction.originWorld, viewport);
  const current = worldToScreen(interaction.currentWorld, viewport);
  // The drag can run in any direction, so the raw pair may describe a rect with
  // negative extents; `fillRect` tolerates that but `setLineDash` phase and the
  // corner rounding do not read cleanly, so normalize first.
  const rect = rectFromPoints(origin, current);

  ctx.save();
  ctx.globalAlpha = MARQUEE_FILL_ALPHA;
  ctx.fillStyle = theme.accent;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash(MARQUEE_DASH);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.setLineDash([]);
}

/* -------------------------------------------------------------- selection -- */

function drawMemberOutlines(
  ctx: CanvasRenderingContext2D,
  elements: readonly CanvasElement[],
  viewport: Viewport,
  theme: CanvasTheme
): void {
  ctx.save();
  ctx.globalAlpha = MEMBER_OUTLINE_ALPHA;
  ctx.strokeStyle = theme.borderStrong;
  ctx.lineWidth = 1;

  for (const element of elements) {
    const corners = elementScreenCorners(element, viewport);
    strokePolygon(ctx, corners);
  }

  ctx.restore();
}

/**
 * An element's four corners in screen space, rotated about its own centre.
 *
 * Computed here rather than reusing the handle set because a member of a
 * multi-selection keeps its own angle while the group box does not.
 */
function elementScreenCorners(
  element: CanvasElement,
  viewport: Viewport
): readonly ScreenPoint[] {
  const rect = elementRect(element);
  const pivot = rectCenter(rect);
  const unrotated = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];

  return unrotated.map((corner) => {
    const rotated = rotatePoint(corner, pivot, element.rotation);
    return worldToScreen(worldPoint(rotated.x, rotated.y), viewport);
  });
}

function drawSelectionFrame(
  ctx: CanvasRenderingContext2D,
  set: SelectionHandleSet,
  theme: CanvasTheme,
  withRotationStem: boolean
): void {
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = SELECTION_OUTLINE_WIDTH_PX;
  ctx.setLineDash([]);
  strokePolygon(ctx, set.corners);

  if (!withRotationStem) return;

  // Stem connecting the top edge to the rotation handle, so the floating disc
  // reads as attached to the box rather than as a stray dot.
  const north = midpoint(set.corners[0], set.corners[1]);
  const rotate = set.handles.find((target) => target.handle === 'rotate');
  if (rotate === undefined) return;

  ctx.beginPath();
  ctx.moveTo(north.x, north.y);
  ctx.lineTo(rotate.center.x, rotate.center.y);
  ctx.stroke();
}

function drawHandles(
  ctx: CanvasRenderingContext2D,
  set: SelectionHandleSet,
  theme: CanvasTheme
): void {
  ctx.lineWidth = SELECTION_OUTLINE_WIDTH_PX;
  ctx.strokeStyle = theme.accent;
  // Filled with the page colour, not left hollow: a hollow handle over a dark
  // shape is invisible, and over a busy one it disappears into the artwork.
  ctx.fillStyle = theme.background;
  ctx.setLineDash([]);

  for (const target of set.handles) {
    if (target.handle === 'rotate') {
      drawRotationHandle(ctx, target);
      continue;
    }
    const rect = handleScreenRect(target);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.fill();
    ctx.stroke();
  }
}

function drawRotationHandle(ctx: CanvasRenderingContext2D, target: HandleTarget): void {
  ctx.beginPath();
  ctx.arc(target.center.x, target.center.y, ROTATION_HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/* ----------------------------------------------------------------- shared -- */

function strokePolygon(ctx: CanvasRenderingContext2D, points: readonly ScreenPoint[]): void {
  const first = points[0];
  if (first === undefined) return;

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point === undefined) continue;
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
  ctx.stroke();
}

function midpoint(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  return screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
}
