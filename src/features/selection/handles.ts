/**
 * Resize and rotation handle geometry.
 *
 * Handles are computed in **screen space** and are the one part of the editor
 * that deliberately does not scale with zoom. An 8px grab target is 8px whether
 * you are at 5% or 3200%; a handle expressed in world units would be a
 * sub-pixel speck when zoomed out and cover the whole shape when zoomed in.
 *
 * The positions themselves still come from world space, rotated with the
 * selection: for a single tilted element the handles sit on the tilted box, so
 * dragging the 'e' handle widens the shape along its own axis rather than along
 * the screen's. Only their *size* is screen-fixed.
 */

import {
  HANDLE_HIT_PADDING_PX,
  HANDLE_SIZE_PX,
  ROTATION_HANDLE_OFFSET_PX,
} from '@/constants';
import type { ResizeHandle, ScreenPoint, ScreenRect, TransformHandle, Viewport } from '@/types';
import { screenRect, worldPoint, worldToScreen } from '@/utils/coords';
import { rectCenter, rotatePoint } from '@/utils/geometry';
import type { SelectionBounds } from './bounds';

export interface HandleTarget {
  readonly handle: TransformHandle;
  /** Centre of the grab target, in screen pixels. */
  readonly center: ScreenPoint;
}

export interface SelectionHandleSet {
  /** Selection box corners in screen space - nw, ne, se, sw. Already rotated. */
  readonly corners: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  /** Screen-space centre of the selection; the rotation pivot. */
  readonly center: ScreenPoint;
  /** The selection's angle in radians. Always 0 for a multi-selection. */
  readonly rotation: number;
  readonly handles: readonly HandleTarget[];
}

/**
 * Unit-square positions of the eight resize handles, in hit-test priority
 * order: corners first, then edges. At small selection sizes the two overlap,
 * and a corner (two-axis resize) is the more useful thing to grab.
 */
const HANDLE_ANCHORS: readonly (readonly [ResizeHandle, number, number])[] = [
  ['nw', 0, 0],
  ['ne', 1, 0],
  ['se', 1, 1],
  ['sw', 0, 1],
  ['n', 0.5, 0],
  ['e', 1, 0.5],
  ['s', 0.5, 1],
  ['w', 0, 0.5],
];

export const RESIZE_HANDLES: readonly ResizeHandle[] = HANDLE_ANCHORS.map(([handle]) => handle);

export function computeSelectionHandles(
  bounds: SelectionBounds,
  viewport: Viewport
): SelectionHandleSet | null {
  if (bounds.kind === 'none') return null;

  const { rect, rotation } = bounds;
  const pivot = rectCenter(rect);

  /** Unit-square coordinate → rotated world position → screen position. */
  const anchorToScreen = (fx: number, fy: number): ScreenPoint => {
    const unrotated = { x: rect.x + fx * rect.width, y: rect.y + fy * rect.height };
    const rotated = rotatePoint(unrotated, pivot, rotation);
    return worldToScreen(worldPoint(rotated.x, rotated.y), viewport);
  };

  const north = anchorToScreen(0.5, 0);

  const handles: HandleTarget[] = HANDLE_ANCHORS.map(([handle, fx, fy]) => ({
    handle,
    center: anchorToScreen(fx, fy),
  }));

  /*
   * The rotation handle floats a fixed screen distance beyond the top edge,
   * along the selection's own "up".
   *
   * World up is (0, -1); rotating it by θ gives (sin θ, -cos θ). The viewport
   * transform is a uniform positive scale plus a translation, so it preserves
   * direction - the same unit vector is valid in screen space, and the offset
   * can be applied directly in pixels. That is what keeps the handle exactly
   * ROTATION_HANDLE_OFFSET_PX from the edge at every zoom instead of drifting
   * away as you zoom in.
   */
  const upX = Math.sin(rotation);
  const upY = -Math.cos(rotation);
  handles.push({
    handle: 'rotate',
    center: {
      x: north.x + upX * ROTATION_HANDLE_OFFSET_PX,
      y: north.y + upY * ROTATION_HANDLE_OFFSET_PX,
    } as ScreenPoint,
  });

  return {
    corners: [
      anchorToScreen(0, 0),
      anchorToScreen(1, 0),
      anchorToScreen(1, 1),
      anchorToScreen(0, 1),
    ],
    center: worldToScreen(worldPoint(pivot.x, pivot.y), viewport),
    rotation,
    handles,
  };
}

/** The painted square for a handle: HANDLE_SIZE_PX on a side, centred on it. */
export function handleScreenRect(target: HandleTarget): ScreenRect {
  const half = HANDLE_SIZE_PX / 2;
  return screenRect(target.center.x - half, target.center.y - half, HANDLE_SIZE_PX, HANDLE_SIZE_PX);
}

/**
 * Which handle, if any, is under a screen point.
 *
 * The grab target is larger than the painted square by `HANDLE_HIT_PADDING_PX`
 * on every side - an 8px square is a hard target for a trackpad and impossible
 * for a finger, and Fitts' law does not care what we drew. `handles` is already
 * ordered rotate → corners → edges, so overlapping targets resolve to the one a
 * user is more likely to have meant.
 *
 * The test is a square, not a circle: it matches the painted shape, and it is
 * four comparisons instead of a hypotenuse.
 */
export function hitTestHandle(
  point: ScreenPoint,
  set: SelectionHandleSet | null
): TransformHandle | null {
  if (set === null) return null;

  const reach = HANDLE_SIZE_PX / 2 + HANDLE_HIT_PADDING_PX;

  // 'rotate' is appended last but must win: it sits outside the box, so nothing
  // else can legitimately claim its pixels.
  for (const target of set.handles) {
    if (target.handle !== 'rotate') continue;
    if (withinReach(point, target, reach)) return 'rotate';
  }

  for (const target of set.handles) {
    if (target.handle === 'rotate') continue;
    if (withinReach(point, target, reach)) return target.handle;
  }

  return null;
}

function withinReach(point: ScreenPoint, target: HandleTarget, reach: number): boolean {
  return (
    Math.abs(point.x - target.center.x) <= reach && Math.abs(point.y - target.center.y) <= reach
  );
}
