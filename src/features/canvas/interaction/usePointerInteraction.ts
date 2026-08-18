/**
 * The adapter between DOM pointer events and the pure machine.
 *
 * Everything impure lives here: pointer capture, the store, the element
 * factories, the wheel listener, the cursor. The machine decides *what* should
 * happen; this file is the only place that makes it happen.
 *
 * Nothing is throttled. The renderer already coalesces to one paint per frame
 * (`Renderer.markDirty`), so a throttle here would not remove a single draw - it
 * would only delay the store write behind it, which is input latency you can
 * feel on a trackpad and cannot get back.
 *
 * The hook holds its transient state in refs, so a whole gesture costs zero
 * React renders:
 *
 *   - `machineState` - the authority; mirrored into the store so the renderer
 *     can draw the marquee.
 *   - `snapshot`     - the elements as they were when the transaction opened.
 *     Transform intents carry a *total* delta and are replayed against this, so
 *     nothing compounds and an abort leaves nothing behind.
 *   - `draftId`      - the in-progress element a draw tool is dragging out. It
 *     is a real element inside a real transaction, which gives the draw a live
 *     preview through the ordinary render path instead of a second one.
 *   - `spaceHeld` / `lastPointer` - modal pan, and the position Escape happens at.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { ZOOM_WHEEL_SENSITIVITY } from '@/constants';
import { hitTestPoint } from '@/features/canvas/engine/hitTest';
import {
  executeIntents,
  type GestureRefs,
  type GestureSnapshot,
} from '@/features/canvas/interaction/executeIntents';
import { elementsInPaintOrder } from '@/features/elements/tree';
import { selectionBounds } from '@/features/selection/bounds';
import { computeSelectionHandles, hitTestHandle } from '@/features/selection/handles';
import { isGestureLocked } from '@/features/selection/gestureTargets';
import {
  descendTarget,
  pointerEligibility,
  resolveSelectionTarget,
  transformSet,
} from '@/features/selection/resolve';
import { selectEnteredGroupId, useCanvasStore, type CanvasStore } from '@/store';
import type {
  ElementId,
  InteractionState,
  ScreenPoint,
  TransformHandle,
  WorldPoint,
} from '@/types';
import {
  eventToScreenPoint,
  screenToWorld,
  wheelDeltaToZoomFactor,
  worldPoint,
} from '@/utils/coords';
import { rectCenter } from '@/utils/geometry';
import { cursorFor } from './cursor';
import {
  reduce,
  type InteractionContext,
  type InteractionEvent,
  type InteractionHit,
  type InteractionIntent,
  type Modifiers,
  type PointerButton,
} from './machine';

interface PointerSample {
  readonly screen: ScreenPoint;
  readonly world: WorldPoint;
  readonly modifiers: Modifiers;
}

/** The fields this hook reads off an event - satisfied by pointer and wheel events alike. */
interface PointerLikeEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export interface PointerInteractionHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  readonly onDoubleClick: () => void;
}

const IDLE: InteractionState = { kind: 'idle' };

export function usePointerInteraction(
  canvasRef: RefObject<HTMLCanvasElement | null>
): PointerInteractionHandlers {
  const machineState = useRef<InteractionState>(IDLE);
  const snapshot = useRef<GestureSnapshot | null>(null);
  const draftId = useRef<ElementId | null>(null);
  const spaceHeld = useRef(false);
  const lastPointer = useRef<PointerSample | null>(null);

  /* ------------------------------------------------------------- intents -- */

  // The two refs the executor mutates, bundled once. Refs are stable for the
  // life of the component, so this object is too - which is what keeps
  // `runIntents` and everything depending on it from being rebuilt per render.
  const gesture = useRef<GestureRefs>({ snapshot, draftId }).current;

  const runIntents = useCallback(
    (intents: readonly InteractionIntent[]): void => {
      executeIntents(intents, gesture);
    },
    [gesture]
  );

  /* -------------------------------------------------------------- cursor -- */

  const applyCursor = useCallback(
    (probe: PointerProbe): void => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const cursor = cursorFor({
        state: machineState.current,
        tool: useCanvasStore.getState().tool,
        hoveredHandle: probe.handle,
        hoveringElement: probe.hit.kind === 'element',
        selectionRotation: probe.rotation,
        spaceHeld: spaceHeld.current,
      });
      // Written straight to the element rather than held in React state: a
      // cursor change per pointermove through `useState` would re-render the
      // canvas component on every frame of a hover, which is the exact cost this
      // architecture exists to avoid.
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    },
    [canvasRef]
  );

  const refreshCursor = useCallback((): void => {
    const sample = lastPointer.current;
    const idle = machineState.current.kind === 'idle';
    applyCursor(
      idle && sample !== null ? probeUnderPointer(useCanvasStore.getState(), sample) : EMPTY_PROBE
    );
  }, [applyCursor]);

  /* ------------------------------------------------------------ dispatch -- */

  const dispatch = useCallback(
    (event: InteractionEvent, sample: PointerSample | null): void => {
      const resolved = sample ?? lastPointer.current;
      if (canvasRef.current === null || resolved === null) return;

      const store = useCanvasStore.getState();
      // A hit test costs a walk of the document plus the handle geometry, and
      // only the idle state can act on the answer. Mid-gesture it is not computed.
      const probe =
        machineState.current.kind === 'idle' ? probeUnderPointer(store, resolved) : EMPTY_PROBE;

      const context: InteractionContext = {
        worldPoint: resolved.world,
        screenPoint: resolved.screen,
        modifiers: resolved.modifiers,
        tool: store.tool,
        hit: probe.hit,
        selection: store.selection,
        viewport: store.viewport,
        selectionCenterWorld: probe.centerWorld,
        lockAspect: store.lockAspect,
        // Read through the tree rather than off the selected elements: with a
        // group selected, `element.locked` is the *group's* own flag, so a group
        // whose members are every one of them locked would report unlocked and
        // be offered handles it must refuse.
        selectionLocked: isGestureLocked(store.elements, store.selection),
        enteredGroupId: selectEnteredGroupId(store),
      };

      const result = reduce(machineState.current, event, context);
      runIntents(result.intents);

      if (result.state !== machineState.current) {
        machineState.current = result.state;
        // Mirrored into the store because the renderer's overlay pass draws the
        // marquee from `scene.interaction`. The canvas component does not
        // subscribe to it, so this write buys a paint and no React work.
        useCanvasStore.getState().setInteraction(result.state);
      }

      // Mid-gesture the probe was skipped, so a gesture that just *ended* has no
      // hover information to draw a cursor from and would fall back to the
      // default arrow until the pointer moved again. Re-probe in that one case.
      if (probe === EMPTY_PROBE && machineState.current.kind === 'idle') refreshCursor();
      else applyCursor(probe);
    },
    [applyCursor, canvasRef, refreshCursor, runIntents]
  );

  const sampleFrom = useCallback(
    (event: PointerLikeEvent): PointerSample | null => {
      const canvas = canvasRef.current;
      if (canvas === null) return null;
      const screen = eventToScreenPoint(event, canvas.getBoundingClientRect());
      const sample: PointerSample = {
        screen,
        world: screenToWorld(screen, useCanvasStore.getState().viewport),
        modifiers: {
          shift: event.shiftKey,
          alt: event.altKey,
          mod: event.metaKey || event.ctrlKey,
          space: spaceHeld.current,
        },
      };
      lastPointer.current = sample;
      return sample;
    },
    [canvasRef]
  );

  /* ------------------------------------------------------------ handlers -- */

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      // Capture first: a fast drag that leaves the canvas - or the window - must
      // keep delivering moves here, or the gesture ends wherever the pointer
      // crossed the edge and the transaction is never closed.
      canvas.setPointerCapture(event.pointerId);
      // Default-prevented for the middle button only, to kill Windows autoscroll
      // - which would otherwise drop an anchor puck on the canvas the moment a
      // middle-drag pan begins. Deliberately *not* prevented for the primary
      // button: `preventDefault` on pointerdown suppresses the compatibility
      // mouse events, and `dblclick` (which enters text editing) is one of them.
      // Stray text selection is handled with `select-none` in the markup instead.
      if (event.button === MIDDLE_BUTTON) event.preventDefault();
      // Canvas focus-on-click is not universal, so it is taken explicitly.
      canvas.focus({ preventScroll: true });
      dispatch({ kind: 'pointerdown', button: buttonOf(event.button) }, sampleFrom(event));
    },
    [canvasRef, dispatch, sampleFrom]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      dispatch({ kind: 'pointermove' }, sampleFrom(event));
    },
    [dispatch, sampleFrom]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      dispatch({ kind: 'pointerup' }, sampleFrom(event));
      const canvas = canvasRef.current;
      // Guarded: the browser releases implicit capture on pointerup by itself,
      // and releasing a pointer that is no longer captured throws.
      if (canvas?.hasPointerCapture(event.pointerId) === true) {
        canvas.releasePointerCapture(event.pointerId);
      }
    },
    [canvasRef, dispatch, sampleFrom]
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      dispatch({ kind: 'cancel' }, sampleFrom(event));
    },
    [dispatch, sampleFrom]
  );

  const onDoubleClick = useCallback(() => {
    dispatch({ kind: 'doubleclick' }, null);
  }, [dispatch]);

  /* ----------------------------------------------------------- tool swap -- */

  useEffect(
    () =>
      /*
       * A tool can change mid-gesture - the shortcut registry binds bare letters
       * and nothing stops `R` arriving during a drag. `setTool` resets the
       * store's interaction to idle on its own, which would leave this hook
       * holding a `dragging` state and, worse, an open transaction that nothing
       * would ever commit: autosave would stay blocked and undo would refuse to
       * run. Cancelling rolls the gesture back and re-syncs the two.
       */
      useCanvasStore.subscribe((state, previous) => {
        if (state.tool === previous.tool || machineState.current.kind === 'idle') return;
        dispatch({ kind: 'cancel' }, null);
      }),
    [dispatch]
  );

  /* --------------------------------------------------------------- wheel -- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const onWheel = (event: WheelEvent): void => {
      // Attached by hand rather than as an `onWheel` prop: React registers wheel
      // listeners on the root as passive, so `preventDefault` inside a React
      // handler is ignored and the page scrolls behind the canvas.
      event.preventDefault();
      const sample = sampleFrom(event);
      if (sample === null) return;
      const store = useCanvasStore.getState();

      // A trackpad pinch arrives as a wheel event with `ctrlKey` set - the
      // browser synthesises it and there is no gesture event to read. Cmd/Ctrl
      // is the mouse-wheel zoom every editor binds, and lands in the same branch.
      if (event.ctrlKey || event.metaKey) {
        store.zoomAtCursor(
          sample.screen,
          wheelDeltaToZoomFactor(event.deltaY, ZOOM_WHEEL_SENSITIVITY)
        );
        return;
      }

      const scale = event.deltaMode === WHEEL_DELTA_LINE ? LINE_HEIGHT_PX : 1;
      let dx = event.deltaX * scale;
      let dy = event.deltaY * scale;
      // Some platforms already swap the axes for shift+wheel; synthesising the
      // swap unconditionally would undo theirs.
      if (event.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      // Negated: a wheel notch "down" moves the content up, i.e. the camera down.
      store.panBy(-dx, -dy);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [canvasRef, sampleFrom]);

  /* ------------------------------------------------------------ keyboard -- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space' && !spaceHeld.current) {
        spaceHeld.current = true;
        // Space scrolls the page and re-triggers a focused button; neither is
        // wanted while it is acting as the pan modifier.
        if (event.target === document.body || event.target === canvasRef.current) {
          event.preventDefault();
        }
        refreshCursor();
        return;
      }
      // Escape is claimed *only* while a gesture is in flight. Idle, it belongs
      // to whatever dialog or field is open - this is not the app's key handler,
      // which lives at the root and dispatches through the shortcut registry.
      if (event.key === 'Escape' && machineState.current.kind !== 'idle') {
        event.stopPropagation();
        dispatch({ kind: 'keydown', key: 'Escape' }, null);
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return;
      spaceHeld.current = false;
      refreshCursor();
    };

    // A window that loses focus keeps no reliable pointer or modifier state, so
    // an in-flight gesture is rolled back rather than left half-applied.
    const onBlur = (): void => {
      spaceHeld.current = false;
      if (machineState.current.kind !== 'idle') dispatch({ kind: 'cancel' }, null);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [canvasRef, dispatch, refreshCursor]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onDoubleClick };
}

/* ------------------------------------------------------------------ probe -- */

interface PointerProbe {
  readonly hit: InteractionHit;
  readonly handle: TransformHandle | null;
  readonly centerWorld: WorldPoint | null;
  readonly rotation: number;
}

const EMPTY_PROBE: PointerProbe = {
  hit: { kind: 'none' },
  handle: null,
  centerWorld: null,
  rotation: 0,
};

/**
 * What is under the pointer, in priority order: handles beat elements, because
 * they sit *on top of* the selection and are the smaller target - a press just
 * inside the box near a corner means "resize", not "drag".
 *
 * The handle box comes from `transformSet`, not the raw selection - the same
 * set `executeIntents.beginTransaction` measures its resize/rotate snapshot
 * against (see the comment there). Reading the raw selection here instead
 * (what this used to do) hit-tested handles against a box a group's own
 * cached rect or a lock-inflated union could disagree with, so the corner a
 * user grabbed did not line up with the corner the drag actually pivoted on.
 * One shared expression for both closes that by construction.
 */
function probeUnderPointer(store: CanvasStore, sample: PointerSample): PointerProbe {
  const bounds = selectionBounds(transformSet(store.elements, store.selection));
  const handle = hitTestHandle(sample.screen, computeSelectionHandles(bounds, store.viewport));

  const centerWorld =
    bounds.kind === 'none'
      ? null
      : (() => {
          const center = rectCenter(bounds.rect);
          return worldPoint(center.x, center.y);
        })();
  const rotation = bounds.kind === 'none' ? 0 : bounds.rotation;

  if (handle !== null) return { hit: { kind: 'handle', handle }, handle, centerWorld, rotation };

  // Paint order, not root order: a group's members are not in `elements.order`
  // at all, so a root-level walk cannot see them and clicking a grouped element
  // would land on whatever is behind it. The eligibility predicate is what keeps
  // the members of a hidden or locked group out - facts that live on the
  // ancestor, which the engine's own `isPickable` cannot reach.
  const document = store.elements;
  const element = hitTestPoint(
    sample.world,
    elementsInPaintOrder(document),
    store.viewport,
    pointerEligibility(document)
  );
  if (element === null) {
    return { hit: { kind: 'none' }, handle: null, centerWorld, rotation };
  }

  const entered = selectEnteredGroupId(store);
  return {
    hit: {
      kind: 'element',
      id: element.id,
      type: element.type,
      selectId: resolveSelectionTarget(document, element.id, entered),
      enterGroupId: descendTarget(document, element.id, entered),
    },
    handle: null,
    centerWorld,
    rotation,
  };
}

/* ------------------------------------------------------------------ input -- */

/** `WheelEvent.deltaMode` for line-based deltas (Firefox on Windows). */
const WHEEL_DELTA_LINE = 1;
/** Nominal line height used to convert those into pixels. */
const LINE_HEIGHT_PX = 16;

const MIDDLE_BUTTON = 1;
const SECONDARY_BUTTON = 2;

function buttonOf(button: number): PointerButton {
  if (button === MIDDLE_BUTTON) return 'middle';
  if (button === SECONDARY_BUTTON) return 'secondary';
  return 'primary';
}
