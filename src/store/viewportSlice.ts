/**
 * The camera.
 *
 * In the store because the renderer, the zoom readout, the minimap, and the
 * saved project all need it - but deliberately **not** in history: nobody
 * expects Ctrl+Z to undo a scroll (docs/architecture.md#5).
 *
 * Every transform is delegated to `utils/coords.ts`. There is no arithmetic on
 * `panX`/`panY`/`zoom` in this file beyond adding a screen-space pan delta,
 * because the moment two places know the transform they start to disagree about
 * it - and coordinate-space bugs are the hardest class in a canvas editor to
 * see.
 */

import { ZOOM_STEPS } from '@/constants';
import type { CanvasStore } from '@/store/index';
import type { Rect, ScreenPoint, Viewport } from '@/types';
import {
  clampZoom,
  defaultViewport,
  screenPoint,
  viewportToFit,
  zoomAroundPoint,
} from '@/utils/coords';
import type { StateCreator } from 'zustand';

export interface ViewportSizePx {
  readonly width: number;
  readonly height: number;
}

export interface ViewportSlice {
  readonly viewport: Viewport;
  /**
   * The canvas's CSS size. Not part of the camera, but kept beside it because
   * culling, "zoom to fit", and centre-anchored zoom all need it and the alternative
   * is threading it through every call site. The canvas component owns writing it.
   */
  readonly viewportSize: ViewportSizePx;

  setViewportSize: (width: number, height: number) => void;
  setViewport: (viewport: Viewport) => void;
  /** Pan by a *screen* delta. Pan is stored in screen px, so this is a plain add. */
  panBy: (dxScreen: number, dyScreen: number) => void;
  /** Wheel / pinch zoom, holding the world point under the cursor fixed. */
  zoomAtCursor: (cursorScreen: ScreenPoint, factor: number) => void;
  /** The +/- controls: walk `ZOOM_STEPS` so repeated clicks land on round numbers. */
  zoomToStep: (direction: 'in' | 'out', anchorScreen?: ScreenPoint) => void;
  zoomToFit: (contentBounds: Rect, sizePx: ViewportSizePx) => void;
  resetView: (sizePx: ViewportSizePx) => void;
}

const INITIAL_SIZE: ViewportSizePx = { width: 0, height: 0 };

/** Float noise means `zoom === step` is unreliable; a strict step needs a margin. */
const STEP_EPSILON = 1e-6;

function nextStep(current: number, direction: 'in' | 'out'): number {
  if (direction === 'in') {
    return ZOOM_STEPS.find((step) => step > current + STEP_EPSILON) ?? clampZoom(current);
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const step = ZOOM_STEPS[i];
    if (step !== undefined && step < current - STEP_EPSILON) return step;
  }
  return clampZoom(current);
}

export const createViewportSlice: StateCreator<CanvasStore, [], [], ViewportSlice> = (
  set,
  get
) => ({
  viewport: { panX: 0, panY: 0, zoom: 1 },
  viewportSize: INITIAL_SIZE,

  setViewportSize: (width, height) => {
    const current = get().viewportSize;
    if (current.width === width && current.height === height) return;
    set({ viewportSize: { width, height } });
  },

  setViewport: (viewport) => {
    set({ viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } });
  },

  panBy: (dxScreen, dyScreen) => {
    const { viewport } = get();
    set({
      viewport: { ...viewport, panX: viewport.panX + dxScreen, panY: viewport.panY + dyScreen },
    });
  },

  zoomAtCursor: (cursorScreen, factor) => {
    const { viewport } = get();
    set({ viewport: zoomAroundPoint(viewport, cursorScreen, viewport.zoom * factor) });
  },

  zoomToStep: (direction, anchorScreen) => {
    const { viewport, viewportSize } = get();
    // Without an explicit anchor the viewport centre is the only choice that
    // doesn't slide the drawing off screen; falling back to (0,0) would make
    // the +/- buttons drag content towards the top-left corner.
    const anchor = anchorScreen ?? screenPoint(viewportSize.width / 2, viewportSize.height / 2);
    set({ viewport: zoomAroundPoint(viewport, anchor, nextStep(viewport.zoom, direction)) });
  },

  zoomToFit: (contentBounds, sizePx) => {
    set({ viewport: viewportToFit(contentBounds, sizePx.width, sizePx.height) });
  },

  resetView: (sizePx) => {
    set({ viewport: defaultViewport(sizePx.width, sizePx.height) });
  },
});

export function selectZoomPercent(state: CanvasStore): number {
  return Math.round(state.viewport.zoom * 100);
}
