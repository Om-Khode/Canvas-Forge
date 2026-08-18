import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { resizeElements } from '@/features/elements/operations';
import type { RectangleElement, Rect, ResizeHandle } from '@/types';

/*
  The landing page's rectangle is driven by the editor's own resize maths.

  `resizeElements` is a pure function over elements and a handle, with no store
  and no canvas behind it, so the demo gets correct anchor-pinning for all eight
  handles - including "drag the north-west corner and the south-east one stays
  put" - from the same code the real tool runs. Reimplementing it would be more
  lines, and the copy would be the one that drifts.

  Coordinates are plain stage pixels rather than world units: there is no camera
  on this page, so a screen/world split would be ceremony with nothing on the
  other side of it.
*/

/** Small enough to read as a chip, large enough to still be grabbable. */
const MIN_SIZE = { width: 132, height: 92 };
/** Bounded so the rectangle cannot be stretched across the whole panel. */
const MAX_SIZE = { width: 460, height: 330 };
/** Breathing room kept between the rectangle and the stage edge. */
const EDGE_INSET = 16;

export interface DemoRectState {
  readonly rect: Rect;
  readonly active: boolean;
  readonly handle: ResizeHandle | null;
  readonly onBodyPointerDown: (event: ReactPointerEvent) => void;
  readonly onHandlePointerDown: (event: ReactPointerEvent, handle: ResizeHandle) => void;
}

export interface Stage {
  readonly width: number;
  readonly height: number;
  /**
   * The stage element, needed to turn a pointer position into stage-local
   * coordinates. `null` means the caller is already passing local coordinates,
   * which only tests do.
   */
  readonly element?: HTMLElement | null;
}

interface Gesture {
  readonly kind: 'move' | 'resize';
  readonly handle: ResizeHandle | null;
  readonly startX: number;
  readonly startY: number;
  readonly origin: Rect;
  /** Stage position in viewport space, captured once so the drag cannot drift. */
  readonly stageX: number;
  readonly stageY: number;
}

/** A throwaway element, so the editor's transform maths has something to chew on. */
function asElement(rect: Rect): RectangleElement {
  return {
    id: 'demo',
    type: 'rectangle',
    name: 'Demo',
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    strokeStyle: 'solid',
    cornerRadius: 0,
  };
}

function clamp(value: number, low: number, high: number): number {
  // `high` can fall below `low` on a stage too small to hold the minimum, and
  // an unguarded clamp would then return the wrong bound.
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** Size bounds for this stage: never larger than the stage can hold. */
function limits(stage: Stage) {
  return {
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    maxWidth: Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, stage.width - EDGE_INSET * 2)),
    maxHeight: Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, stage.height - EDGE_INSET * 2)),
  };
}

/** Keeps a *moved* rectangle inside the stage. Size is untouched - a drag never resizes. */
function containMove(rect: Rect, stage: Stage): Rect {
  const { minWidth, minHeight, maxWidth, maxHeight } = limits(stage);
  const width = clamp(rect.width, minWidth, maxWidth);
  const height = clamp(rect.height, minHeight, maxHeight);
  return {
    width,
    height,
    x: clamp(rect.x, EDGE_INSET, stage.width - width - EDGE_INSET),
    y: clamp(rect.y, EDGE_INSET, stage.height - height - EDGE_INSET),
  };
}

/**
 * Keeps a *resized* rectangle within bounds without moving the anchored edge.
 *
 * This is the part that has to be done on edges rather than on width and height,
 * and the reason is a bug this had: clamping the size after the fact and leaving
 * the origin alone works when the handle grows the box rightward, and is wrong
 * the moment it does not. Drag the north-west handle inward and `resizeElements`
 * correctly pins the south-east corner by pushing `x` right as the width falls;
 * bumping the width back up to the minimum afterwards then pushed the *right*
 * edge out, so the box visibly jumped sideways at the moment it hit its limit.
 *
 * Clamping the moving edge against the stationary one cannot express that
 * mistake: whichever edge the handle is not dragging simply never changes.
 */
function containResize(raw: Rect, handle: ResizeHandle, stage: Stage): Rect {
  const { minWidth, minHeight, maxWidth, maxHeight } = limits(stage);

  let left = raw.x;
  let right = raw.x + raw.width;
  let top = raw.y;
  let bottom = raw.y + raw.height;

  if (handle.includes('w')) {
    left = clamp(left, Math.max(EDGE_INSET, right - maxWidth), right - minWidth);
  } else if (handle.includes('e')) {
    right = clamp(right, left + minWidth, Math.min(stage.width - EDGE_INSET, left + maxWidth));
  }

  if (handle.includes('n')) {
    top = clamp(top, Math.max(EDGE_INSET, bottom - maxHeight), bottom - minHeight);
  } else if (handle.includes('s')) {
    bottom = clamp(bottom, top + minHeight, Math.min(stage.height - EDGE_INSET, top + maxHeight));
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function useDemoRect(stage: Stage, initial: Rect): DemoRectState {
  const [rect, setRect] = useState<Rect>(initial);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  /** Once the visitor has moved it, the layout stops having an opinion. */
  const touched = useRef(false);

  // The stage is read inside window listeners bound once per gesture, so it
  // arrives through a ref rather than as an effect dependency that would tear
  // the listeners down and rebuild them on every resize of the window.
  const stageRef = useRef(stage);
  useEffect(() => {
    stageRef.current = stage;
  });

  /*
    Centre it until the visitor takes over, then only ever contain it.

    The stage measures 0×0 on the first render, so a hard-coded starting position
    would sit wherever it happened to land once the real size arrived - fine at
    one viewport and adrift at every other. Recomputing while untouched keeps it
    composed at any size; stopping on first contact means a window resize never
    yanks the rectangle out from under a hand mid-drag.
  */
  useEffect(() => {
    if (stage.width === 0 || stage.height === 0) return;
    setRect((current) =>
      touched.current
        ? containMove(current, stage)
        : containMove(
            {
              ...current,
              x: (stage.width - current.width) / 2,
              y: (stage.height - current.height) / 2,
            },
            stage
          )
    );
    // Keyed on the two numbers rather than the object: callers build a fresh
    // `{ width, height }` each render, so depending on it would re-run this on
    // every render and fight the drag it is supposed to leave alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.width, stage.height]);

  const begin = useCallback(
    (event: ReactPointerEvent, kind: 'move' | 'resize', handle: ResizeHandle | null): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      touched.current = true;

      /*
        The stage's own position, captured at the start of the gesture.

        Pointer events report viewport coordinates; the rectangle lives in
        stage-local ones. Handing `resizeElements` a viewport pointer against a
        stage-local box is comparing two different origins, and it is why a
        resize used to snap to its bound instead of following the cursor.
      */
      const bounds = stageRef.current.element?.getBoundingClientRect();
      setGesture({
        kind,
        handle,
        startX: event.clientX,
        startY: event.clientY,
        origin: rect,
        stageX: bounds?.left ?? 0,
        stageY: bounds?.top ?? 0,
      });
    },
    [rect]
  );

  const onBodyPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      begin(event, 'move', null);
    },
    [begin]
  );

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent, handle: ResizeHandle) => {
      event.stopPropagation();
      begin(event, 'resize', handle);
    },
    [begin]
  );

  useEffect(() => {
    if (gesture === null) return;

    const onMove = (event: PointerEvent): void => {
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;

      if (gesture.kind === 'move') {
        setRect(
          containMove(
            { ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy },
            stageRef.current
          )
        );
        return;
      }
      if (gesture.handle === null) return;

      // The editor's own resize, fed the pointer as an absolute position in the
      // *same space as the box* - the shape that function expects, and the
      // reason a drag never accumulates float drift.
      const pointer = {
        x: gesture.startX + dx - gesture.stageX,
        y: gesture.startY + dy - gesture.stageY,
      };
      const patch = resizeElements(
        [asElement(gesture.origin)],
        gesture.origin,
        gesture.handle,
        pointer
      )['demo'];
      if (patch === undefined) return;

      setRect(
        containResize(
          {
            x: patch.x ?? gesture.origin.x,
            y: patch.y ?? gesture.origin.y,
            width: patch.width ?? gesture.origin.width,
            height: patch.height ?? gesture.origin.height,
          },
          gesture.handle,
          stageRef.current
        )
      );
    };

    const end = (): void => {
      setGesture(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    const previousSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.style.userSelect = previousSelect;
    };
  }, [gesture]);

  return {
    rect,
    active: gesture !== null,
    handle: gesture?.handle ?? null,
    onBodyPointerDown,
    onHandlePointerDown,
  };
}
