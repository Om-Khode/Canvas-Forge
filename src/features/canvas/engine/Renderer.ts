/**
 * The frame loop.
 *
 * Owns a `<canvas>` and a scene getter, and nothing else. No store handle, no
 * React, no event listeners - the owner calls `markDirty()` when something
 * changed and the renderer asks for the scene at the top of the next frame.
 * Because it has no idea where the data comes from, PNG export can point one of
 * these at an offscreen canvas with a fitted viewport and get pixel-identical
 * output from the same code path.
 */

import { rectsIntersect, rotatedBounds } from '@/utils/geometry';
import { visibleWorldRect } from '@/utils/coords';
import type { CanvasElement, ElementId, Rect, Viewport } from '@/types';
import { drawDotGrid } from './background';
import { drawElement } from './drawers';
import type { DrawerDeps } from './drawers/shared';
import { elementMatrix } from './matrix';
import { drawOverlay } from './overlay';
import { SCREEN_CHROME, type RenderScene, type SceneSource } from './scene';
import { getCanvasTheme } from './theme';

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly getScene: SceneSource;

  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;

  private frameHandle: number | null = null;
  private destroyed = false;

  /**
   * Ids of elements whose drawer has thrown. Kept so a malformed element logs
   * once instead of once per frame - at 60fps a single bad shape would produce
   * 3,600 console entries a minute and bury everything else.
   */
  private readonly failedElements = new Set<ElementId>();

  constructor(canvas: HTMLCanvasElement, getScene: SceneSource) {
    const ctx = canvas.getContext('2d');
    // The only throw in this class. A 2D context is not something the caller
    // can degrade around, and failing at construction is far easier to diagnose
    // than a renderer that silently paints nothing.
    if (ctx === null) throw new Error('Renderer: 2D canvas context unavailable');

    this.canvas = canvas;
    this.ctx = ctx;
    this.getScene = getScene;
  }

  /**
   * Request a repaint. Idempotent within a frame: ten store writes between two
   * frames schedule one rAF and produce one paint. This coalescing is the
   * reason a drag that fires 200 pointermove events still costs 60 draws.
   */
  markDirty(): void {
    if (this.destroyed || this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      this.render();
    });
  }

  /**
   * Resize the backing store.
   *
   * The CSS size and the pixel size are decoupled by `dpr`: the buffer is
   * `css * dpr` device pixels, and the context is scaled by `dpr` so all
   * drawing code below can keep working in CSS pixels. DPR deliberately does
   * *not* enter the viewport transform - folding it in there would leak a
   * factor of two into hit-testing on a retina display, which is a bug that
   * only reproduces on half the machines that see it.
   */
  resize(cssWidth: number, cssHeight: number, dpr = 1): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;

    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    // Assigning width/height resets all context state, so skip the write when
    // nothing changed - otherwise a no-op resize silently clears the canvas.
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;

    this.markDirty();
  }

  /** Paint synchronously, right now. The entry point for PNG export. */
  renderNow(): void {
    if (this.destroyed) return;
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.failedElements.clear();
  }

  /* ------------------------------------------------------------- private -- */

  private render(): void {
    const scene = this.getScene();
    const theme = getCanvasTheme();
    const { ctx } = this;

    const chrome = scene.chrome ?? SCREEN_CHROME;

    // Pass 1 - clear, in CSS pixels with only the DPR scale applied.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    // The backdrop is either the editor's canvas colour, an explicit colour an
    // export asked for, or nothing at all - the last of which is what leaves a
    // PNG genuinely transparent rather than merely pale.
    const backdrop = chrome.background ? theme.background : (scene.backgroundColor ?? null);
    if (backdrop !== null) {
      ctx.fillStyle = backdrop;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }

    // Pass 2 - world space. DPR is folded into the same `setTransform` because
    // `setTransform` replaces rather than composes; applying them separately
    // would drop the DPR scale.
    this.applyWorldTransform(scene.viewport);
    const visible = visibleWorldRect(this.cssWidth, this.cssHeight, scene.viewport);
    if (chrome.grid) drawDotGrid(ctx, visible, scene.viewport, theme);

    const deps: DrawerDeps = { resolveImage: scene.resolveImage, theme };
    for (const element of scene.elements) {
      if (!element.visible) continue;
      // Culling against the rotation-aware AABB. This is what keeps frame cost
      // proportional to what is on screen rather than to document size - the
      // difference between 10k elements being fine and being unusable.
      if (!rectsIntersect(visible, worldBounds(element))) continue;
      this.drawOne(element, deps);
    }

    // Pass 3 - screen space. Reset so the overlay's pixel sizes are literal.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (chrome.overlay) drawOverlay(ctx, scene, theme);
  }

  private applyWorldTransform(viewport: Viewport): void {
    const scale = viewport.zoom * this.dpr;
    this.ctx.setTransform(
      scale,
      0,
      0,
      scale,
      viewport.panX * this.dpr,
      viewport.panY * this.dpr
    );
  }

  /**
   * Draw one element inside its own transform and alpha.
   *
   * `save`/`restore` are in a `try`/`finally` rather than bracketing the call:
   * a drawer that throws part-way through has already mutated `fillStyle`,
   * `lineDash`, the transform, and possibly left a path open. Without the
   * `finally` that state leaks into every subsequent element and one bad shape
   * corrupts the whole frame. With it, the damage is exactly one missing shape.
   */
  private drawOne(element: CanvasElement, deps: DrawerDeps): void {
    const { ctx } = this;
    ctx.save();
    try {
      const [a, b, c, d, e, f] = elementMatrix(element);
      ctx.transform(a, b, c, d, e, f);
      // Multiplied into the inherited alpha rather than assigned, so a future
      // group opacity composes instead of being overwritten.
      ctx.globalAlpha *= clamp01(element.opacity);
      drawElement(ctx, element, deps);
    } catch (error) {
      this.reportFailure(element, error);
    } finally {
      ctx.restore();
    }
  }

  private reportFailure(element: CanvasElement, error: unknown): void {
    if (this.failedElements.has(element.id)) return;
    this.failedElements.add(element.id);
    console.error(
      `Renderer: failed to draw ${element.type} element "${element.id}"; skipping it in future frames' logs.`,
      error
    );
  }
}

function worldBounds(element: CanvasElement): Rect {
  return rotatedBounds(
    { x: element.x, y: element.y, width: element.width, height: element.height },
    element.rotation
  );
}

/** Opacity arrives from JSON and from numeric inputs; neither is trustworthy. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export type { RenderScene, SceneSource };
