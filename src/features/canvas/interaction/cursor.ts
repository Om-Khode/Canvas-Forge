/**
 * Interaction state → CSS cursor.
 *
 * Pure and separate from the machine because the cursor is a function of what
 * the pointer is *over*, not only of what state the gesture is in - hovering a
 * handle while idle must already show the resize arrow, or the handles look
 * decorative until you press one.
 *
 * The interesting part is that resize cursors rotate with the selection. CSS
 * gives four bidirectional resize cursors at 45° increments; the handle's
 * outward bearing plus the selection's angle picks one of them. Hardcoding
 * `nw → nwse-resize` is right exactly once, at 0°: turn the element 90° and the
 * north-west handle now points north-east, and a cursor that disagrees with the
 * direction the shape will actually grow is worse than no cursor at all.
 */

import type { InteractionState, ResizeHandle, ToolId, TransformHandle } from '@/types';
import { isDrawingTool } from './machine';

/**
 * Outward compass bearing of each handle in degrees, measured clockwise from
 * north - the same convention as the element's `rotation`, so the two add.
 */
const HANDLE_BEARING_DEG: Readonly<Record<ResizeHandle, number>> = {
  n: 0,
  ne: 45,
  e: 90,
  se: 135,
  s: 180,
  sw: 225,
  w: 270,
  nw: 315,
};

/** Indexed by 45°-bucket of the bearing modulo 180°. */
const AXIS_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'] as const;

/**
 * A resize axis is symmetric - dragging the north handle and the south handle
 * move along the same line - so only the bearing modulo 180° matters, and the
 * four cursors quantize that into 45° buckets.
 */
export function resizeCursor(handle: ResizeHandle, rotationRadians: number): string {
  const bearing = HANDLE_BEARING_DEG[handle] + (rotationRadians * 180) / Math.PI;
  const wrapped = ((bearing % 180) + 180) % 180;
  // `% 4` catches the 179°-rounds-to-180° case, which is the vertical axis again.
  return AXIS_CURSORS[Math.round(wrapped / 45) % 4] ?? 'ns-resize';
}

export interface CursorInput {
  readonly state: InteractionState;
  readonly tool: ToolId;
  /** Handle under the pointer while idle. `null` when the pointer is elsewhere. */
  readonly hoveredHandle: TransformHandle | null;
  readonly hoveringElement: boolean;
  /** The selection box's angle in radians. Always 0 for a multi-selection. */
  readonly selectionRotation: number;
  readonly spaceHeld: boolean;
}

export function cursorFor(input: CursorInput): string {
  const active = activeGestureCursor(input);
  if (active !== null) return active;

  // Space wins over everything: it is a modal override of the current tool, and
  // a user holding it expects to pan regardless of what is under the pointer.
  if (input.spaceHeld || input.tool === 'hand') return 'grab';

  if (input.hoveredHandle === 'rotate') return 'grab';
  if (input.hoveredHandle !== null)
    return resizeCursor(input.hoveredHandle, input.selectionRotation);

  if (input.tool === 'text') return 'text';
  // The image tool places a box the same way the shape tools do, so it reads the
  // same way under the pointer.
  if (isDrawingTool(input.tool) || input.tool === 'image') return 'crosshair';

  return input.hoveringElement ? 'move' : 'default';
}

/** Cursor implied by an in-flight gesture, or `null` while idle. */
function activeGestureCursor(input: CursorInput): string | null {
  const { state } = input;
  switch (state.kind) {
    case 'idle':
      return null;
    case 'panning':
      return 'grabbing';
    case 'pending-drag':
    case 'dragging':
      return 'move';
    case 'marquee':
    case 'drawing':
      return 'crosshair';
    case 'resizing':
      return resizeCursor(state.handle, input.selectionRotation);
    case 'rotating':
      // No standard rotate cursor exists; `grabbing` at least says "you are
      // holding something", which is closer than `crosshair` or `default`.
      return 'grabbing';
    case 'editing-text':
      return 'text';
  }
}
