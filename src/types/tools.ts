/**
 * Tools and the pointer interaction state machine.
 *
 * The interaction states are typed as a discriminated union rather than a set
 * of booleans (`isDragging`, `isResizing`, …). Booleans permit contradictory
 * combinations; a union makes "dragging and resizing at once" unrepresentable,
 * and each state carries exactly the data that state needs.
 */

import type { ElementId } from './element';
import type { ResizeHandle, WorldPoint, WorldRect } from './geometry';

export type ToolId =
  | 'select'
  | 'hand'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'freehand'
  | 'text'
  | 'image';

/** Tools that create an element by dragging out a box. */
export type DrawingToolId = Extract<
  ToolId,
  'rectangle' | 'ellipse' | 'line' | 'arrow' | 'freehand' | 'text'
>;

export type InteractionState =
  | { readonly kind: 'idle' }
  /** Pointer is down but hasn't passed the drag threshold - may still be a click. */
  | {
      readonly kind: 'pending-drag';
      readonly originWorld: WorldPoint;
      readonly targetId: ElementId;
      readonly additive: boolean;
    }
  | {
      readonly kind: 'dragging';
      readonly originWorld: WorldPoint;
      readonly currentWorld: WorldPoint;
    }
  | {
      readonly kind: 'resizing';
      readonly handle: ResizeHandle;
      readonly originWorld: WorldPoint;
      readonly currentWorld: WorldPoint;
      readonly preserveAspect: boolean;
      readonly fromCenter: boolean;
    }
  | {
      readonly kind: 'rotating';
      readonly centerWorld: WorldPoint;
      readonly startAngle: number;
      readonly currentAngle: number;
      readonly snapped: boolean;
    }
  | {
      readonly kind: 'marquee';
      readonly originWorld: WorldPoint;
      readonly currentWorld: WorldPoint;
      readonly additive: boolean;
    }
  | {
      readonly kind: 'drawing';
      readonly tool: DrawingToolId;
      readonly originWorld: WorldPoint;
      readonly currentWorld: WorldPoint;
      /** Only populated for the freehand tool. */
      readonly points: readonly WorldPoint[];
    }
  | {
      readonly kind: 'panning';
      readonly originScreenX: number;
      readonly originScreenY: number;
      readonly originPanX: number;
      readonly originPanY: number;
    }
  | { readonly kind: 'editing-text'; readonly elementId: ElementId };

/** What the renderer needs to paint the in-progress interaction overlay. */
export interface InteractionPreview {
  readonly marqueeRect: WorldRect | null;
  readonly snapGuides: readonly { readonly axis: 'x' | 'y'; readonly value: number }[];
}
