/**
 * PNG export - the payoff for keeping the engine React-free.
 *
 * There is no second renderer here. The document is painted by the *same*
 * `Renderer` the screen uses, pointed at an offscreen canvas with a viewport
 * fitted to the exported bounds. Anything the editor can draw, the export can
 * draw, and the two cannot drift apart because there is only one drawing path.
 *
 * Four things in this file are not obvious:
 *
 * 1. **Images must be decoded *before* the render.** `imageStore.resolveImage`
 *    is synchronous by contract - the frame loop cannot await - so it returns
 *    `null` on a cache miss and kicks off a decode in the background. On screen
 *    that is invisible: a placeholder is painted and the next frame has the
 *    pixels. An export has no next frame, so calling `renderNow()` on a cold
 *    cache produces a file with every image missing. `awaitImageDecodes` gates
 *    the render on the decodes landing.
 *
 * 2. **The chrome has to be suppressed.** The renderer unconditionally fills
 *    the themed page colour and paints the dot grid, which is right on screen
 *    and wrong in a file. The renderer takes chrome as part of the scene, so
 *    the export asks for `BARE_CHROME` and supplies its own backdrop colour -
 *    or `null` for a genuinely transparent PNG.
 *
 * 3. **Canvas dimensions are capped by the browser.** Exceeding the cap does
 *    not throw; it yields a canvas that silently rasterises to nothing. So the
 *    scale is clamped up front and the clamp is *reported*, because "your 3×
 *    export quietly became 1.4×" is information the user needs and "here is a
 *    blank PNG" is not.
 *
 * 4. **The canvas is injectable.** jsdom has no 2D context, so the arithmetic
 *    (bounds, padding, scale clamping, the fitted viewport) is a pure function
 *    that is unit-tested, and the pixel work is behind a seam - the same split
 *    `imageStore` uses for its codec.
 */

import { Renderer } from '@/features/canvas/engine/Renderer';
import { BARE_CHROME, type RenderScene } from '@/features/canvas/engine/scene';
import { jsonFilename } from '@/features/export/json';
import { contentBounds } from '@/features/selection/bounds';
import { imageStore } from '@/services/imageStore';
import { describeCause, err, ok, type Result } from '@/services/result';
import type { CanvasElement, ElementId, InteractionState, Rect, Viewport } from '@/types';
import { viewportToFit } from '@/utils/coords';
import { expandRect } from '@/utils/geometry';

export const PNG_MIME = 'image/png';
export const PNG_EXTENSION = '.png';

/** The scale factors the export dialog offers. */
export const PNG_SCALES = [1, 2, 3] as const;
export type PngScale = (typeof PNG_SCALES)[number];

/** World units of empty space around the content. Matches the SVG exporter. */
const DEFAULT_PADDING = 24;

/**
 * Conservative cross-browser canvas limits.
 *
 * Chrome and Firefox accept 32767 on a side; Safari is lower and also enforces
 * a total-area budget. 16384 / 268M px is the largest pair that is safe
 * everywhere this app claims to run. Over the limit a canvas does not throw -
 * `getContext` succeeds and every draw is discarded - which is precisely why
 * this is clamped rather than attempted and caught.
 */
const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_AREA = 268_435_456;

/**
 * Ceiling on the wait for image decodes. Needed because `imageStore` remembers
 * keys whose decode already failed and never re-notifies for them, so a project
 * referencing a blob that is gone would otherwise hang the export forever.
 */
const IMAGE_DECODE_TIMEOUT_MS = 5_000;

const EMPTY_SELECTION: ReadonlySet<ElementId> = new Set<ElementId>();
const IDLE_INTERACTION: InteractionState = { kind: 'idle' };

/* ------------------------------------------------------------------ plan -- */

export interface PngPlanOptions {
  readonly scale?: number;
  readonly padding?: number;
  readonly maxDimension?: number;
  readonly maxArea?: number;
}

export interface PngExportPlan {
  /** The world rectangle that will be rasterised, padding included. */
  readonly worldBounds: Rect;
  readonly requestedScale: number;
  /** What the scale actually became after clamping. */
  readonly scale: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly viewport: Viewport;
  /** True when the browser's canvas limit forced `scale` below `requestedScale`. */
  readonly clamped: boolean;
}

/**
 * Largest scale that keeps the raster inside the canvas limits.
 *
 * Both constraints are applied: a long thin document hits the per-side limit
 * first, a large square one hits the area limit first, and the smaller of the
 * two wins. The area bound is a square root because area grows with the square
 * of the scale.
 */
function clampScale(bounds: Rect, scale: number, maxDimension: number, maxArea: number): number {
  if (bounds.width <= 0 || bounds.height <= 0) return scale;
  return Math.min(
    scale,
    maxDimension / bounds.width,
    maxDimension / bounds.height,
    Math.sqrt(maxArea / (bounds.width * bounds.height))
  );
}

/**
 * Everything about an export that can be computed without a canvas: the padded
 * world rect, the effective scale, the pixel size, and the viewport transform
 * that maps one onto the other.
 *
 * Split out from `exportPng` because the export dialog shows a live dimension
 * estimate, and because it is the only part that can be tested under jsdom.
 */
export function planPngExport(bounds: Rect, options: PngPlanOptions = {}): PngExportPlan {
  const requestedScale = options.scale ?? 1;
  const worldBounds = expandRect(bounds, options.padding ?? DEFAULT_PADDING);
  const scale = clampScale(
    worldBounds,
    requestedScale,
    options.maxDimension ?? MAX_CANVAS_DIMENSION,
    options.maxArea ?? MAX_CANVAS_AREA
  );

  const widthPx = Math.max(1, Math.round(worldBounds.width * scale));
  const heightPx = Math.max(1, Math.round(worldBounds.height * scale));

  return {
    worldBounds,
    requestedScale,
    scale,
    widthPx,
    heightPx,
    // Zero padding, because `worldBounds` already carries it. Reusing the shared
    // fit routine rather than writing `panX = -x * zoom` here keeps exactly one
    // implementation of "frame this rect in this many pixels" in the codebase.
    viewport: viewportToFit(worldBounds, widthPx, heightPx, 0),
    clamped: scale < requestedScale,
  };
}

/** The plan for a set of elements, or `null` when there is nothing to draw. */
export function planPngExportFor(
  elements: readonly CanvasElement[],
  options: PngPlanOptions = {}
): PngExportPlan | null {
  const bounds = contentBounds(elements);
  return bounds === null ? null : planPngExport(bounds, options);
}

/* --------------------------------------------------------------- painting -- */

export interface PaintOptions {
  readonly widthPx: number;
  readonly heightPx: number;
  /** `null` leaves the PNG transparent. */
  readonly background: string | null;
}

function paintWithRenderer(
  canvas: HTMLCanvasElement,
  scene: RenderScene,
  options: PaintOptions
): void {
  const renderer = new Renderer(canvas, () => ({
    ...scene,
    // The editor's backdrop and dot grid are the canvas *as a place to work*;
    // in a file they are decoration the user never drew, and an opaque backdrop
    // would make "transparent PNG" a lie. The engine takes this as part of the
    // scene, so the export builds a different scene rather than mutating global
    // theme state and hoping nothing else paints in the meantime.
    chrome: BARE_CHROME,
    backgroundColor: options.background,
  }));
  try {
    // dpr 1: the scale factor already lives in the viewport's zoom, and folding
    // it in twice would double every exported dimension.
    renderer.resize(options.widthPx, options.heightPx, 1);
    renderer.renderNow();
  } finally {
    renderer.destroy();
  }
}

function createExportCanvas(widthPx: number, heightPx: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  return canvas;
}

function encodeCanvas(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob);
    }, PNG_MIME);
  });
}

/* --------------------------------------------------------- image decoding -- */

export interface ImageDecodeDeps {
  readonly resolveImage: (key: string) => CanvasImageSource | null;
  readonly subscribeImages: (listener: (key: string) => void) => () => void;
  readonly decodeTimeoutMs?: number;
}

function imageKeys(elements: readonly CanvasElement[]): string[] {
  const keys = new Set<string>();
  for (const element of elements) {
    if (element.type === 'image') keys.add(element.imageKey);
  }
  return [...keys];
}

/**
 * Blocks until every referenced image is in the decode cache.
 *
 * `resolveImage` is the renderer's synchronous read: it returns what is decoded
 * *now* and starts a decode on a miss. The store then notifies subscribers when
 * each decode settles - on failure as well as success, which is what lets a
 * missing blob resolve the wait instead of stalling it.
 */
export async function awaitImageDecodes(
  keys: readonly string[],
  deps: ImageDecodeDeps
): Promise<void> {
  if (keys.length === 0) return;

  const pending = new Set(keys.filter((key) => deps.resolveImage(key) === null));
  if (pending.size === 0) return;

  await new Promise<void>((settle) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      settle();
    };

    const unsubscribe = deps.subscribeImages((key) => {
      pending.delete(key);
      if (pending.size === 0) finish();
    });
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      finish,
      deps.decodeTimeoutMs ?? IMAGE_DECODE_TIMEOUT_MS
    );

    // A decode started by the first `resolveImage` pass can land before the
    // subscription exists. Re-checking closes that window; without it an export
    // of a warm cache would sit here until the timeout.
    for (const key of [...pending]) {
      if (deps.resolveImage(key) !== null) pending.delete(key);
    }
    if (pending.size === 0) finish();
  });
}

/* --------------------------------------------------------------- exporting -- */

export type PngExportErrorKind = 'empty' | 'canvas-unavailable' | 'render-failed' | 'encode-failed';

export interface PngExportError {
  readonly kind: PngExportErrorKind;
  readonly message: string;
}

export interface PngExportResult {
  readonly blob: Blob;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly scale: number;
  /** The scale the caller asked for, when clamping changed it. `null` otherwise. */
  readonly clampedFrom: number | null;
}

export interface PngExportRequest extends PngPlanOptions {
  /** Already in paint order, bottom → top. Hidden elements are dropped here. */
  readonly elements: readonly CanvasElement[];
  /** A CSS colour, or `null` for a transparent PNG. */
  readonly background?: string | null;
}

export interface PngExportDeps extends Partial<ImageDecodeDeps> {
  readonly createCanvas?: (widthPx: number, heightPx: number) => HTMLCanvasElement;
  readonly paint?: (canvas: HTMLCanvasElement, scene: RenderScene, options: PaintOptions) => void;
  readonly encode?: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
}

export async function exportPng(
  request: PngExportRequest,
  deps: PngExportDeps = {}
): Promise<Result<PngExportResult, PngExportError>> {
  const elements = request.elements.filter((element) => element.visible);
  const plan = planPngExportFor(elements, request);
  if (plan === null) {
    return err({ kind: 'empty', message: 'There is nothing to export.' });
  }

  const resolveImage = deps.resolveImage ?? ((key: string) => imageStore.resolveImage(key));
  const subscribeImages =
    deps.subscribeImages ?? ((listener: (key: string) => void) => imageStore.subscribe(listener));

  await awaitImageDecodes(imageKeys(elements), {
    resolveImage,
    subscribeImages,
    ...(deps.decodeTimeoutMs === undefined ? {} : { decodeTimeoutMs: deps.decodeTimeoutMs }),
  });

  const scene: RenderScene = {
    elements,
    viewport: plan.viewport,
    // Empty and idle so no selection frame, handle, or marquee is baked in -
    // the export must show the artwork, not the editor's state.
    selectedIds: EMPTY_SELECTION,
    interaction: IDLE_INTERACTION,
    resolveImage,
  };

  let canvas: HTMLCanvasElement;
  try {
    canvas = (deps.createCanvas ?? createExportCanvas)(plan.widthPx, plan.heightPx);
  } catch (cause) {
    return err({
      kind: 'canvas-unavailable',
      message: `Could not create a ${plan.widthPx}×${plan.heightPx} canvas: ${describeCause(cause)}`,
    });
  }

  try {
    (deps.paint ?? paintWithRenderer)(canvas, scene, {
      widthPx: plan.widthPx,
      heightPx: plan.heightPx,
      background: request.background ?? null,
    });
  } catch (cause) {
    return err({
      kind: 'render-failed',
      message: `The export could not be drawn: ${describeCause(cause)}`,
    });
  }

  let blob: Blob | null;
  try {
    blob = await (deps.encode ?? encodeCanvas)(canvas);
  } catch (cause) {
    return err({ kind: 'encode-failed', message: `PNG encoding failed: ${describeCause(cause)}` });
  }
  if (blob === null) {
    return err({ kind: 'encode-failed', message: 'The browser returned no PNG data.' });
  }

  return ok({
    blob,
    widthPx: plan.widthPx,
    heightPx: plan.heightPx,
    scale: plan.scale,
    clampedFrom: plan.clamped ? plan.requestedScale : null,
  });
}

/** `"My design"` → `"my-design.png"`. Shares the slug rules with JSON export. */
export function pngFilename(projectName: string): string {
  return jsonFilename(projectName, PNG_EXTENSION);
}
