/**
 * Pointer-driven drag-to-reorder for the layers list.
 *
 * **Why not HTML5 drag-and-drop.** `draggable` + `dragstart`/`dragover` is the
 * obvious answer and the wrong one: it does not fire for touch at all, the drag
 * image is a browser-drawn bitmap that cannot be styled, and `dragover`'s
 * `preventDefault`-to-allow-drop protocol is a well-known source of "the drop
 * silently does nothing" bugs. Pointer events are one code path for mouse, pen,
 * and touch, and everything the user sees is ordinary DOM this file controls.
 *
 * **Why a threshold.** The same 3px rule the canvas uses. A click that selects a
 * layer must not also reorder it because the hand moved a pixel during the
 * press.
 *
 * **Why one store call.** The drop calls one store action exactly once, and
 * that routes through `applyDocument` once, so a reorder - or a reparent, which
 * moves an id between two lists - is one undo entry with no explicit
 * transaction needed. Intermediate positions during the drag are drawn as an
 * indicator, never written to the document.
 *
 * **Why the landing place is arithmetic rather than measured.** This used to
 * snapshot every row's `DOMRect` at pointerdown and count how many midpoints
 * the pointer had passed. That carried two defects and acquired a third: it was
 * a forced layout over the whole list on every press, the cached rects went
 * stale the moment the list scrolled (so mid-drag scrolling was documented as
 * unsupported), and once the list virtualized, most rows had no element to
 * measure at all. Rows are a known fixed height, so the pointer resolves to
 * `floor((pointer − listTop + scrollTop) / rowHeight)` plus the offset within
 * that row - correct for rows that were never rendered, correct while
 * scrolling, and no layout read per gesture.
 *
 * **Why a row and an offset rather than a gap number.** A gap in a flat list is
 * one integer; in a tree the same gap can mean several different parents, so
 * the pointer has to say *which row* and *where in it* and let `dropTarget.ts`
 * turn that into a parent and an index. This file stays about the gesture.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

import {
  DRAG_THRESHOLD_PX,
  LAYER_AUTOSCROLL_MARGIN,
  LAYER_AUTOSCROLL_MAX_SPEED,
  LAYER_LIST_PADDING,
} from '@/constants';
import type { DropPlan } from './dropTarget';
import type { ElementId } from '@/types';

interface DragOrigin {
  readonly id: ElementId;
  /**
   * The dragged row's display index at pointerdown. No document write
   * happens mid-drag, so this cannot go stale over the gesture - it is
   * resolved once here rather than re-scanned on every `plan` call.
   */
  readonly fromIndex: number;
  readonly startY: number;
  /** Mutable: flips once the pointer has travelled past the threshold. */
  active: boolean;
  /** Mutable: kept off React state so the drop handler cannot read a stale plan. */
  plan: DropPlan | null;
  /** Mutable: latest pointer position, so the auto-scroll loop can re-derive the plan. */
  clientY: number;
}

export interface UseLayerReorderOptions {
  /** The scrolling element that wraps the rows. */
  readonly containerRef: RefObject<HTMLElement | null>;
  /**
   * Turns a pointer position into a landing place, or `null` for a drop that
   * must be refused. Called on every move, so it must be cheap and pure -
   * `fromIndex` is threaded straight through from `begin` rather than
   * resolved here, for the same reason.
   */
  readonly plan: (
    draggingId: ElementId,
    fromIndex: number,
    rowIndex: number,
    offsetInRow: number
  ) => DropPlan | null;
  /** Fired once, on a completed drop that has somewhere to land. */
  readonly onDrop: (id: ElementId, plan: DropPlan) => void;
  readonly rowHeight: number;
  /** Total rows in the list - not just the rendered window. */
  readonly count: number;
}

export interface LayerReorder {
  /** The row being dragged, for styling it as lifted. */
  readonly draggingId: ElementId | null;
  /**
   * Where the drop would land. Null while idle *and* whenever the pointer is
   * over somewhere the drop is refused, so every position the indicator can be
   * drawn is a position the drop actually lands.
   */
  readonly dropPlan: DropPlan | null;
  /** `fromIndex` is the row's own display index at the moment of pointerdown. */
  readonly begin: (event: ReactPointerEvent, id: ElementId, fromIndex: number) => void;
}

/** Same landing place as far as the indicator is concerned. */
function samePlan(a: DropPlan | null, b: DropPlan | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rowIndex === b.rowIndex && a.zone === b.zone;
}

export function useLayerReorder({
  containerRef,
  plan,
  onDrop,
  rowHeight,
  count,
}: UseLayerReorderOptions): LayerReorder {
  /** True from pointerdown to pointerup - including the sub-threshold part. */
  const [armed, setArmed] = useState(false);
  /** Non-null only once the drag is real; drives the indicator. */
  const [drag, setDrag] = useState<{ id: ElementId; plan: DropPlan | null } | null>(null);
  const originRef = useRef<DragOrigin | null>(null);

  /*
    The move/up listeners are bound once per gesture and must not be torn down
    and rebuilt mid-drag, so callbacks and sizes are reached through a
    latest-value ref rather than listed as effect dependencies - callers pass
    inline arrows, and `count` changes the moment a drop lands.
  */
  const latest = useRef({ plan, onDrop, rowHeight, count });
  useEffect(() => {
    latest.current = { plan, onDrop, rowHeight, count };
  });

  /** Where the pointer would land the row, in list coordinates. */
  const planFor = useCallback(
    (id: ElementId, fromIndex: number, clientY: number): DropPlan | null => {
      const container = containerRef.current;
      if (container === null) return null;
      const { rowHeight: height, count: total, plan: resolve } = latest.current;
      if (total === 0) return null;

      const top = container.getBoundingClientRect().top;
      const y = clientY - top + container.scrollTop - LAYER_LIST_PADDING;
      // Clamped into the rows before the split, so dragging above the first row
      // or below the last one means that row's outer edge rather than a
      // negative remainder or an index past the end.
      const clamped = Math.min(Math.max(y, 0), total * height - 1);
      const rowIndex = Math.floor(clamped / height);
      return resolve(id, fromIndex, rowIndex, clamped - rowIndex * height);
    },
    [containerRef]
  );

  const begin = useCallback((event: ReactPointerEvent, id: ElementId, fromIndex: number): void => {
    if (event.button !== 0) return;
    originRef.current = {
      id,
      fromIndex,
      startY: event.clientY,
      active: false,
      plan: null,
      clientY: event.clientY,
    };
    setArmed(true);
  }, []);

  useEffect(() => {
    if (!armed) return;

    const finish = (commit: boolean): void => {
      const origin = originRef.current;
      originRef.current = null;
      setArmed(false);
      setDrag(null);
      if (!commit || origin === null || !origin.active) return;

      // A refused or unchanged drop has no plan, and issuing nothing is what
      // keeps it out of the undo stack.
      if (origin.plan !== null) latest.current.onDrop(origin.id, origin.plan);
    };

    const applyPlan = (): void => {
      const origin = originRef.current;
      if (origin === null || !origin.active) return;
      origin.plan = planFor(origin.id, origin.fromIndex, origin.clientY);
      // Re-render only when the indicator would actually move, not per pixel.
      setDrag((current) =>
        current !== null && samePlan(current.plan, origin.plan)
          ? current
          : { id: origin.id, plan: origin.plan }
      );
    };

    const onMove = (event: PointerEvent): void => {
      const origin = originRef.current;
      if (origin === null) return;
      origin.clientY = event.clientY;
      if (!origin.active) {
        if (Math.abs(event.clientY - origin.startY) < DRAG_THRESHOLD_PX) return;
        origin.active = true;
      }
      applyPlan();
    };

    const onUp = (): void => {
      finish(true);
    };
    const onCancel = (): void => {
      finish(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape aborts the drag, matching how it aborts a canvas interaction.
      if (event.key === 'Escape') finish(false);
    };

    /*
      Auto-scroll near the edges. Without it a virtualized list is a trap: the
      rows you want to drop between may never have been rendered, and with 2,000
      layers the reachable target set would be whatever happens to be on screen.
      Speed ramps across the margin so the list creeps near the boundary and
      moves quickly at the very edge, rather than lurching the moment you enter.
    */
    let scrollFrame: number | null = null;
    const step = (): void => {
      scrollFrame = requestAnimationFrame(step);
      const origin = originRef.current;
      const container = containerRef.current;
      if (origin === null || !origin.active || container === null) return;

      const rect = container.getBoundingClientRect();
      const fromTop = origin.clientY - rect.top;
      const fromBottom = rect.bottom - origin.clientY;

      let velocity = 0;
      if (fromTop < LAYER_AUTOSCROLL_MARGIN) {
        velocity = -ramp(LAYER_AUTOSCROLL_MARGIN - fromTop);
      } else if (fromBottom < LAYER_AUTOSCROLL_MARGIN) {
        velocity = ramp(LAYER_AUTOSCROLL_MARGIN - fromBottom);
      }
      if (velocity === 0) return;

      const before = container.scrollTop;
      container.scrollTop = before + velocity;
      // At either end the scroll is a no-op, and re-deriving the landing place
      // from an unchanged position would just re-render with the same value.
      if (container.scrollTop !== before) applyPlan();
    };
    scrollFrame = requestAnimationFrame(step);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    };
  }, [armed, containerRef, planFor]);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    // Document-level facts for the duration of the drag: the cursor has to
    // survive leaving the row, and text selection has to stop everywhere.
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  return { draggingId: drag?.id ?? null, dropPlan: drag?.plan ?? null, begin };
}

/** Linear ramp from 0 at the margin's outer edge to full speed at the boundary. */
function ramp(depth: number): number {
  const fraction = Math.min(depth / LAYER_AUTOSCROLL_MARGIN, 1);
  return Math.max(1, Math.round(fraction * LAYER_AUTOSCROLL_MAX_SPEED));
}
