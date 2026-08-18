/**
 * The interaction protocol: what the pointer state machine consumes and what it
 * emits.
 *
 * Split from `machine.ts` so the vocabulary can be read on its own. The adapter
 * (`usePointerInteraction`) imports only from here plus `reduce`, which keeps
 * the boundary between "decide" and "execute" legible: anything in this file is
 * a contract between the two halves, anything in `machine.ts` is a decision.
 */

import type {
  DrawingToolId,
  ElementId,
  ElementType,
  InteractionState,
  ResizeHandle,
  ScreenPoint,
  ToolId,
  TransformHandle,
  Viewport,
  WorldPoint,
  WorldRect,
  WorldVector,
} from '@/types';

/* ----------------------------------------------------------------- input -- */

export type PointerButton = 'primary' | 'middle' | 'secondary';

export interface Modifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  /** Cmd on macOS, Ctrl elsewhere. Normalized by the adapter so this file has no platform branch. */
  readonly mod: boolean;
  /** Space held. Turns any tool into a temporary hand tool, as every design tool does. */
  readonly space: boolean;
}

export type InteractionEvent =
  | { readonly kind: 'pointerdown'; readonly button: PointerButton }
  | { readonly kind: 'pointermove' }
  | { readonly kind: 'pointerup' }
  | { readonly kind: 'doubleclick' }
  | { readonly kind: 'keydown'; readonly key: string }
  /** Pointer capture lost, window blurred, pointercancel. Treated as Escape. */
  | { readonly kind: 'cancel' };

/**
 * What is under the pointer. Computed by the adapter because it needs the
 * element list and the handle geometry; the machine only branches on the shape.
 *
 * Hidden and locked elements never appear here. `engine/hitTest.isPickable`
 * excludes an element hidden or locked by its own flags, and
 * `features/selection/resolve.ts`'s `pointerEligibility` excludes one whose
 * *ancestor* is hidden or locked - together they are why there is no lock
 * check below.
 */
export type InteractionHit =
  | { readonly kind: 'none' }
  | { readonly kind: 'handle'; readonly handle: TransformHandle }
  | {
      readonly kind: 'element';
      /** The leaf actually under the pointer. A group has no geometry to hit. */
      readonly id: ElementId;
      readonly type: ElementType;
      /**
       * What a click here would select: the outermost enclosing group, or one
       * level inside the group the user has entered. Resolved by the adapter
       * because it needs the element tree; the machine only compares it against
       * the current selection to decide whether a press has to settle selection
       * now or can defer to pointerup.
       */
      readonly selectId: ElementId;
      /**
       * The group a double-click would descend into, or `null` when the leaf is
       * already directly selectable - in which case double-click keeps its old
       * meaning of "edit this text".
       */
      readonly enterGroupId: ElementId | null;
    };

export interface InteractionContext {
  readonly worldPoint: WorldPoint;
  readonly screenPoint: ScreenPoint;
  readonly modifiers: Modifiers;
  readonly tool: ToolId;
  readonly hit: InteractionHit;
  readonly selection: ReadonlySet<ElementId>;
  readonly viewport: Viewport;
  /** Rotation pivot - the selection's centre. `null` when nothing is selected. */
  readonly selectionCenterWorld: WorldPoint | null;
  /**
   * The sticky aspect-ratio lock from the properties panel. ORed with Shift, so
   * the toggle and the modifier are two ways to ask for the same thing and
   * neither cancels the other.
   */
  readonly lockAspect: boolean;
  /**
   * True when every selected element is locked.
   *
   * The machine cannot work this out for itself - it sees a set of ids, not the
   * elements - so the adapter resolves it. Hit-testing already refuses to pick a
   * locked element, but a selection made from the layers panel bypasses that
   * entirely, which is how a locked element ended up draggable by its handles.
   */
  readonly selectionLocked: boolean;
  /**
   * The group the user has descended into; `null` at the top level.
   *
   * The machine never resolves ids against it - that needs the tree, which is
   * the adapter's side of the wall. It is here so the machine can tell whether
   * there is a level to leave.
   */
  readonly enteredGroupId: ElementId | null;
}

/* ---------------------------------------------------------------- output -- */

export type InteractionIntent =
  | { readonly kind: 'select'; readonly ids: readonly ElementId[] }
  | { readonly kind: 'clearSelection' }
  | { readonly kind: 'toggleSelect'; readonly id: ElementId }
  /** Descend into a group, or return to the top level with `groupId: null`. */
  | { readonly kind: 'enterGroup'; readonly groupId: ElementId | null }
  | { readonly kind: 'marqueeSelect'; readonly rectWorld: WorldRect; readonly additive: boolean }
  | { readonly kind: 'beginTransaction'; readonly label: string }
  | { readonly kind: 'commitTransaction' }
  | { readonly kind: 'abortTransaction' }
  | { readonly kind: 'translate'; readonly deltaWorld: WorldVector }
  | {
      readonly kind: 'resize';
      readonly handle: ResizeHandle;
      readonly pointerWorld: WorldPoint;
      readonly preserveAspect: boolean;
      readonly fromCenter: boolean;
    }
  | {
      readonly kind: 'rotate';
      readonly centerWorld: WorldPoint;
      /** Total rotation since the gesture began, in radians. */
      readonly radians: number;
      readonly snap: boolean;
    }
  | { readonly kind: 'createDraft'; readonly draft: DraftGeometry }
  | { readonly kind: 'updateDraft'; readonly draft: DraftGeometry }
  /** Finalize: select the draft and release the adapter's handle on it. */
  | { readonly kind: 'commitDraft' }
  | { readonly kind: 'panTo'; readonly panX: number; readonly panY: number }
  /** `elementId: null` means "the draft that was just committed". */
  | { readonly kind: 'beginTextEdit'; readonly elementId: ElementId | null }
  | { readonly kind: 'endTextEdit' }
  | { readonly kind: 'requestImageUpload'; readonly worldPoint: WorldPoint };

export interface DraftGeometry {
  readonly tool: DrawingToolId;
  readonly startWorld: WorldPoint;
  readonly endWorld: WorldPoint;
  /** Freehand samples. Exactly `[start, end]` for every other tool. */
  readonly points: readonly WorldPoint[];
}

export interface InteractionResult {
  readonly state: InteractionState;
  readonly intents: readonly InteractionIntent[];
}