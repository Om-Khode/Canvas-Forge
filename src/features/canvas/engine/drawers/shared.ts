/**
 * Paint state helpers shared by the element drawers.
 *
 * Each drawer runs with the context already transformed into the element's
 * local space, so everything here works in local units: a `strokeWidth` of 2 is
 * 2 world units, and the viewport scale in the current transform turns it into
 * the right number of device pixels for free. Setting `lineWidth` in screen
 * pixels here would be the classic bug where strokes stop scaling with zoom.
 */

import { STROKE_DASH_PATTERNS } from '@/constants';
import type { FillProps, LinearElement, StrokeProps, Vec2 } from '@/types';
import type { CanvasTheme } from '../theme';

/**
 * Extra state the drawers need beyond the element itself.
 *
 * Passed as one bag rather than as extra positional parameters so every drawer
 * keeps an identical three-argument signature and the dispatcher stays a plain
 * switch with no per-type argument juggling.
 */
export interface DrawerDeps {
  /** `null` while a decode is pending or the blob is missing - draw a placeholder. */
  readonly resolveImage: (imageKey: string) => CanvasImageSource | null;
  readonly theme: CanvasTheme;
}

export type Drawer<E> = (
  ctx: CanvasRenderingContext2D,
  element: E,
  deps: DrawerDeps
) => void;

/**
 * Applies stroke state and reports whether stroking is worth doing at all.
 *
 * Returning a boolean rather than having callers re-check `stroke !== null`
 * keeps the "is there a stroke" rule in one place - it is three conditions, not
 * one, and a hollow shape with `strokeWidth: 0` would otherwise render as an
 * invisible-but-still-path-built shape on every frame.
 */
export function configureStroke(ctx: CanvasRenderingContext2D, props: StrokeProps): boolean {
  if (props.stroke === null || props.strokeWidth <= 0) return false;

  ctx.strokeStyle = props.stroke;
  ctx.lineWidth = props.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Dash patterns are stored as multiples of stroke width so a 1px dashed line
  // and an 8px dashed line read as the same *style* rather than the thick one
  // looking almost solid.
  const pattern = STROKE_DASH_PATTERNS[props.strokeStyle];
  ctx.setLineDash(pattern.map((segment) => segment * props.strokeWidth));

  return true;
}

export function configureFill(ctx: CanvasRenderingContext2D, props: FillProps): boolean {
  if (props.fill === null) return false;
  ctx.fillStyle = props.fill;
  return true;
}

/**
 * Lines and arrows store endpoints as fractions of their bounding box, so that
 * resize and rotate are the same box transform every other element uses. This
 * turns them back into local pixels at draw time.
 */
export function resolveEndpoints(element: LinearElement): { start: Vec2; end: Vec2 } {
  return {
    start: { x: element.start.x * element.width, y: element.start.y * element.height },
    end: { x: element.end.x * element.width, y: element.end.y * element.height },
  };
}

/**
 * Rounded-rectangle path, built by hand rather than via `ctx.roundRect`.
 *
 * `roundRect` is recent enough that offscreen and non-browser 2D contexts still
 * miss it, and this is eight lines. `arcTo` is used instead of explicit arc
 * centres because it takes the two edge directions and the radius directly,
 * which is exactly the data we have.
 *
 * The radius is clamped to half the shorter side: beyond that the corner arcs
 * from adjacent corners overlap and the path self-intersects, which renders as
 * a pinched bowtie instead of a stadium.
 */
export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));

  ctx.beginPath();
  if (r === 0) {
    ctx.rect(0, 0, width, height);
    return;
  }

  ctx.moveTo(r, 0);
  ctx.arcTo(width, 0, width, height, r);
  ctx.arcTo(width, height, 0, height, r);
  ctx.arcTo(0, height, 0, 0, r);
  ctx.arcTo(0, 0, width, 0, r);
  ctx.closePath();
}
