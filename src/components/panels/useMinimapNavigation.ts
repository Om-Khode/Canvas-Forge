/**
 * The minimap's engine binding, invalidation policy, and drag behaviour.
 *
 * ## Why there is no second renderer here
 *
 * `Renderer` is constructed with a scene *getter*, not with the store, so a
 * second instance pointed at the minimap's own small canvas - with
 * `BARE_CHROME` and a viewport fitted to the content bounds - draws the whole
 * document as a thumbnail using the same drawers, the same transform code and
 * the same culling as the main canvas. Hand-drawing a rectangle per element
 * would be a second rendering path that silently drifts from the first: a
 * rotated ellipse or a freehand stroke would look nothing like itself, and
 * every new element type would need drawing twice.
 *
 * ## Invalidation: two surfaces, two clocks
 *
 * A minimap that repaints 2,000 elements on every frame of a pan makes the app
 * slower, which is the opposite of the point. So the two things it shows sit on
 * two stacked canvases, invalidated by two different signals:
 *
 *  - **The document canvas** (expensive: N elements) is invalidated only when
 *    `state.elements` changes identity - never by the viewport. A pan or a zoom
 *    cannot change what the document looks like, and the fit is derived from
 *    `contentBounds`, which is a function of the document alone. Renders are
 *    additionally rate-limited to `MIN_REDRAW_INTERVAL_MS`, because dragging an
 *    element *does* dirty the document every frame and a thumbnail at ~5fps is
 *    indistinguishable from one at 60fps. The trailing timer guarantees the last
 *    state is always drawn, so the map is never left stale.
 *  - **The overlay canvas** (cheap: two rects and a stroke) carries the viewport
 *    rectangle and the dimming outside it, and is invalidated by viewport and
 *    canvas-size changes.
 *
 * ## Why the viewport rectangle is a canvas and not a `<div>`
 *
 * It was a positioned `<div>` first - one `transform` write per frame, the
 * textbook cheap way to move something. Measured, it cost **~9ms per frame** of
 * a pan on the 2,000-element stress document: a style write invalidates
 * style/pre-paint for the whole document, and with the layers panel listing
 * 2,000 elements that document is ~45,000 nodes. The DOM write was cheap; the
 * DOM it invalidated was not. Painting into a 192×128 canvas touches no DOM at
 * all and the cost went to nothing (docs/performance.md §6). The underlying
 * problem is an un-virtualized layers panel, which is not this file's to fix -
 * but a navigation aid must not be the thing that makes a large document
 * unusable.
 *
 * ## The fit is content-only, on purpose
 *
 * Including the current viewport in the fitted bounds would make panning change
 * the mapping - which would re-fit and repaint the document on every frame,
 * exactly what the split above exists to avoid. The map therefore always frames
 * the document; pan far enough away and the viewport rectangle slides off the
 * edge (it is clipped, and the dimming makes that obvious). The recovery is one
 * click on the map, or the panel's own "zoom to fit" button.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

import { Renderer } from '@/features/canvas/engine/Renderer';
import { BARE_CHROME, type RenderScene } from '@/features/canvas/engine/scene';
import { elementsToPaint } from '@/features/elements/tree';
import { contentBounds } from '@/features/selection/bounds';
import { imageStore, resolveImage } from '@/services/imageStore';
import { useCanvasStore } from '@/store';
import type { CanvasElement, ElementId, InteractionState, Vec2, Viewport } from '@/types';
import {
  defaultViewport,
  eventToScreenPoint,
  screenToWorld,
  viewportToFit,
  visibleWorldRect,
  worldPoint,
  worldRectToScreen,
  worldToScreen,
} from '@/utils/coords';
import { rectCenter, rectContainsPoint } from '@/utils/geometry';

/**
 * CSS pixels. Large enough that a 2,000-element document reads as a shape
 * rather than as noise, small enough to sit over the canvas without becoming
 * furniture. Fixed rather than responsive: the panel is only mounted at `lg`
 * and above, where there is always room for it.
 */
export const MINIMAP_WIDTH_PX = 192;
export const MINIMAP_HEIGHT_PX = 128;

/** Fraction of the map left as breathing room around the content. */
const MINIMAP_FIT_PADDING = 0.06;

/** Floor for the document repaint interval. See the header. */
const MIN_REDRAW_INTERVAL_MS = 200;

/** Zoomed deep into a detail, the true viewport rect is sub-pixel on the map. */
const MIN_INDICATOR_PX = 6;

const INDICATOR_STROKE_PX = 1.5;

const NO_SELECTION: ReadonlySet<ElementId> = new Set<ElementId>();
const IDLE_INTERACTION: InteractionState = { kind: 'idle' };

/**
 * Pointer handlers to spread onto the map surface. Only handlers: the refs are
 * created by the component and passed *in*, the same shape `useRenderer` and
 * `usePointerInteraction` use, so a ref never travels back out through a
 * render-time property read.
 */
export interface MinimapHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

interface DragState {
  readonly pointerId: number;
  /**
   * World-space offset from the pointer to the viewport centre at the moment of
   * the press. Preserved for the whole drag so grabbing the rectangle moves the
   * camera *with* the hand rather than teleporting its centre under the cursor.
   */
  readonly offsetWorld: Vec2;
}

export function useMinimapNavigation(
  documentCanvasRef: RefObject<HTMLCanvasElement | null>,
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>,
  surfaceRef: RefObject<HTMLDivElement | null>,
  /** Only used to repaint the overlay in the other palette when the theme flips. */
  theme: string
): MinimapHandlers {
  /**
   * World → minimap-pixel transform. Written by the document render and read by
   * both the overlay pass and the pointer handlers, so all three agree on one
   * mapping. A ref rather than state: updating it must not re-render, and
   * nothing renders from it.
   */
  const fitRef = useRef<Viewport>(defaultViewport(MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX));
  const dragRef = useRef<DragState | null>(null);
  /** Installed by the effect; called by the drag path and by the theme effect. */
  const drawOverlayRef = useRef<() => void>(noop);

  useEffect(() => {
    const documentCanvas = documentCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (documentCanvas === null || overlayCanvas === null) return;

    const dpr = currentDpr();

    // Captured by the scene getter and replaced wholesale by each document
    // render. The renderer pulls this at the top of its frame; between renders
    // it is exactly the array that was last drawn.
    let elements: readonly CanvasElement[] = [];

    const renderer = new Renderer(documentCanvas, (): RenderScene => ({
      elements,
      viewport: fitRef.current,
      // No selection chrome, no marquee, no grid, no backdrop: the panel's own
      // surface is the background, and a thumbnail with 8px resize handles on
      // it would be illegible.
      selectedIds: NO_SELECTION,
      interaction: IDLE_INTERACTION,
      resolveImage,
      chrome: BARE_CHROME,
      backgroundColor: null,
    }));
    renderer.resize(MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX, dpr);

    /* --------------------------------------------------- overlay canvas -- */

    overlayCanvas.width = Math.round(MINIMAP_WIDTH_PX * dpr);
    overlayCanvas.height = Math.round(MINIMAP_HEIGHT_PX * dpr);
    const overlay = overlayCanvas.getContext('2d');

    let overlayFrame: number | null = null;

    const drawOverlay = (): void => {
      if (overlay === null) return;
      const { viewport, viewportSize } = useCanvasStore.getState();

      overlay.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlay.clearRect(0, 0, MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX);
      if (viewportSize.width === 0 || viewportSize.height === 0) return;

      const visible = visibleWorldRect(viewportSize.width, viewportSize.height, viewport);
      const rect = worldRectToScreen(visible, fitRef.current);
      const width = Math.max(rect.width, MIN_INDICATOR_PX);
      const height = Math.max(rect.height, MIN_INDICATOR_PX);

      // Dim everything, then punch the viewport out of the dimming. One fill and
      // one erase, rather than four rects around a hole that have to agree with
      // each other on every edge.
      overlay.fillStyle = minimapColors().dim;
      overlay.fillRect(0, 0, MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX);
      overlay.clearRect(rect.x, rect.y, width, height);

      overlay.strokeStyle = minimapColors().accent;
      overlay.lineWidth = INDICATOR_STROKE_PX;
      // Inset by half the stroke so the frame sits inside the region it marks
      // rather than straddling its edge.
      overlay.strokeRect(
        rect.x + INDICATOR_STROKE_PX / 2,
        rect.y + INDICATOR_STROKE_PX / 2,
        Math.max(width - INDICATOR_STROKE_PX, 0),
        Math.max(height - INDICATOR_STROKE_PX, 0)
      );
    };

    const markOverlayDirty = (): void => {
      if (overlayFrame !== null) return;
      overlayFrame = requestAnimationFrame(() => {
        overlayFrame = null;
        drawOverlay();
      });
    };
    drawOverlayRef.current = markOverlayDirty;

    /* -------------------------------------------------- document canvas -- */

    let lastRenderAt = Number.NEGATIVE_INFINITY;
    let redrawTimer: number | null = null;

    const renderDocument = (): void => {
      lastRenderAt = performance.now();
      // The same walk the main canvas paints from (`useRenderer`), for the same
      // reason: `order` names root ids only, so a root-level walk draws a group
      // - which paints nothing - instead of what is inside it.
      elements = elementsToPaint(useCanvasStore.getState().elements);

      const bounds = contentBounds(elements);
      fitRef.current =
        bounds === null
          ? defaultViewport(MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX)
          : viewportToFit(bounds, MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX, MINIMAP_FIT_PADDING);

      renderer.markDirty();
      // The fit just moved, so the overlay's mapping did too.
      drawOverlay();
    };

    const scheduleDocumentRender = (): void => {
      if (redrawTimer !== null) return;
      const elapsed = performance.now() - lastRenderAt;
      // Leading edge when the map has been idle, trailing edge otherwise - so a
      // single edit paints immediately and a continuous drag paints at the
      // interval, ending with the final state.
      redrawTimer = window.setTimeout(
        () => {
          redrawTimer = null;
          renderDocument();
        },
        Math.max(0, MIN_REDRAW_INTERVAL_MS - elapsed)
      );
    };

    renderDocument();

    const unsubscribeStore = useCanvasStore.subscribe((next, previous) => {
      // The whole invalidation policy, in two lines. Note what is absent: the
      // selection and the interaction state, neither of which the minimap draws.
      if (next.elements !== previous.elements) scheduleDocumentRender();
      if (next.viewport !== previous.viewport || next.viewportSize !== previous.viewportSize) {
        markOverlayDirty();
      }
    });

    // A decode landing changes pixels without changing the document, exactly as
    // it does for the main canvas.
    const unsubscribeImages = imageStore.subscribe(scheduleDocumentRender);

    return () => {
      unsubscribeStore();
      unsubscribeImages();
      if (overlayFrame !== null) cancelAnimationFrame(overlayFrame);
      if (redrawTimer !== null) window.clearTimeout(redrawTimer);
      drawOverlayRef.current = noop;
      renderer.destroy();
    };
  }, [documentCanvasRef, overlayCanvasRef]);

  useEffect(() => {
    // The dim and the frame are theme tokens, and the canvas does not re-style
    // itself when `data-theme` flips - it has to be repainted.
    refreshMinimapColors();
    drawOverlayRef.current();
  }, [theme]);

  /* ------------------------------------------------------------ pointer -- */

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const surface = surfaceRef.current;
      if (surface === null || event.button !== 0) return;

      // Capture on the surface: a fast drag that leaves the 192×128 map - which
      // is most of them - must keep steering the camera rather than dropping.
      surface.setPointerCapture(event.pointerId);

      const world = worldUnderPointer(event, surface, fitRef.current);
      const { viewport, viewportSize } = useCanvasStore.getState();
      const visible = visibleWorldRect(viewportSize.width, viewportSize.height, viewport);

      if (rectContainsPoint(visible, world)) {
        const centre = rectCenter(visible);
        dragRef.current = {
          pointerId: event.pointerId,
          offsetWorld: { x: centre.x - world.x, y: centre.y - world.y },
        };
        return;
      }

      // Pressing outside the rectangle means "look there", which is a jump by
      // definition; the drag that may follow then moves the camera from there.
      dragRef.current = { pointerId: event.pointerId, offsetWorld: { x: 0, y: 0 } };
      centreCameraOn(world);
    },
    [surfaceRef]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      const surface = surfaceRef.current;
      if (drag === null || surface === null || drag.pointerId !== event.pointerId) return;

      const world = worldUnderPointer(event, surface, fitRef.current);
      centreCameraOn({ x: world.x + drag.offsetWorld.x, y: world.y + drag.offsetWorld.y });
    },
    [surfaceRef]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      // Guarded: the browser releases implicit capture on pointerup by itself,
      // and releasing a pointer that is no longer captured throws.
      const surface = surfaceRef.current;
      if (surface?.hasPointerCapture(event.pointerId) === true) {
        surface.releasePointerCapture(event.pointerId);
      }
    },
    [surfaceRef]
  );

  // `pointercancel` and `pointerup` end the drag identically: there is no
  // in-flight document change to roll back, only a camera that stops following.
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}

/* ---------------------------------------------------------------- colour -- */

interface MinimapColors {
  readonly dim: string;
  readonly accent: string;
}

/**
 * Hex fallbacks for environments where custom properties do not resolve - jsdom,
 * and any offscreen context. Same reasoning (and same shape) as the engine's
 * `theme.ts`: `fillStyle = ''` silently keeps the previous colour, which is the
 * hardest kind of wrong to notice.
 */
const FALLBACK_COLORS: MinimapColors = { dim: 'rgba(28, 28, 31, 0.32)', accent: '#c2603f' };

let cachedColors: MinimapColors | null = null;

/**
 * Read once per theme rather than per frame: `getComputedStyle` forces style
 * resolution, and this runs inside the overlay pass.
 */
function minimapColors(): MinimapColors {
  cachedColors ??= readColors();
  return cachedColors;
}

function refreshMinimapColors(): void {
  cachedColors = null;
}

function readColors(): MinimapColors {
  let styles: CSSStyleDeclaration;
  try {
    styles = getComputedStyle(document.documentElement);
  } catch {
    return FALLBACK_COLORS;
  }
  const read = (token: string, fallback: string): string => {
    const value = styles.getPropertyValue(token).trim();
    return value.length > 0 ? value : fallback;
  };
  return {
    dim: read('--cf-overlay', FALLBACK_COLORS.dim),
    accent: read('--cf-accent', FALLBACK_COLORS.accent),
  };
}

/* ------------------------------------------------------------------ math -- */

/**
 * Pointer → world, through the minimap's own fitted viewport.
 *
 * "Screen space" here is minimap pixels rather than main-canvas pixels, which is
 * the one subtlety in this file: both are screen spaces, they are just different
 * screens. Going through `utils/coords` keeps the arithmetic in the one place
 * that is allowed to know it.
 */
function worldUnderPointer(
  event: ReactPointerEvent<HTMLElement>,
  surface: HTMLElement,
  fit: Viewport
): Vec2 {
  return screenToWorld(eventToScreenPoint(event, surface.getBoundingClientRect()), fit);
}

/**
 * Move the main camera so `target` sits at the centre of the canvas.
 *
 * Expressed as a *pan by a screen delta* rather than by solving for `panX`
 * directly: `worldToScreen` says where the target is now, the canvas centre says
 * where it should be, and the difference is a screen-space delta the viewport
 * slice already knows how to apply. Zoom is untouched - a minimap moves the
 * camera, it does not change the lens.
 */
function centreCameraOn(target: Vec2): void {
  const { viewport, viewportSize, panBy } = useCanvasStore.getState();
  if (viewportSize.width === 0 || viewportSize.height === 0) return;

  const current = worldToScreen(worldPoint(target.x, target.y), viewport);
  panBy(viewportSize.width / 2 - current.x, viewportSize.height / 2 - current.y);
}

function currentDpr(): number {
  return window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

function noop(): void {
  /* Placeholder until the effect installs the real overlay pass. */
}
