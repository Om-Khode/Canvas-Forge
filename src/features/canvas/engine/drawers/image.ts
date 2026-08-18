import type { ImageElement } from '@/types';
import { roundedRectPath, type Drawer } from './shared';

/** Placeholder chrome, in local units. Small and fixed - it is a hint, not UI. */
const PLACEHOLDER_CORNER_RADIUS = 4;
const PLACEHOLDER_DASH = [6, 4];
const PLACEHOLDER_LINE_WIDTH = 1;
/** The inner "mountain" glyph is inset by this fraction of the box on each side. */
const GLYPH_INSET = 0.28;
const GLYPH_MAX_ALPHA = 0.5;

/**
 * Images reference a blob by key and are decoded asynchronously, so a frame can
 * legitimately arrive before the bitmap exists. Drawing a placeholder - rather
 * than skipping, or blocking on the decode - means the element keeps its
 * position and size in the layout while it loads, so nothing jumps when it
 * arrives, and a permanently missing blob is visibly missing instead of
 * invisibly absent.
 */
export const drawImage: Drawer<ImageElement> = (ctx, element, deps) => {
  const source = deps.resolveImage(element.imageKey);

  if (source === null) {
    drawPlaceholder(ctx, element.width, element.height, deps.theme.borderStrong);
    return;
  }

  // Stretched to the element box rather than letterboxed: the element's size is
  // authored by the user (and seeded from `naturalWidth`/`naturalHeight` at
  // insert time), so honouring the box is honouring their resize.
  ctx.drawImage(source, 0, 0, element.width, element.height);
};

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = PLACEHOLDER_LINE_WIDTH;
  ctx.setLineDash(PLACEHOLDER_DASH);
  roundedRectPath(ctx, width, height, PLACEHOLDER_CORNER_RADIUS);
  ctx.stroke();

  // A simplified picture glyph: horizon line plus a peak. Cheap to draw and
  // reads as "image" at any size without needing a font or an asset.
  const inset = Math.min(width, height) * GLYPH_INSET;
  if (inset <= 0) return;

  ctx.setLineDash([]);
  ctx.globalAlpha *= GLYPH_MAX_ALPHA;
  ctx.beginPath();
  ctx.moveTo(inset, height - inset);
  ctx.lineTo(width / 2, inset);
  ctx.lineTo(width - inset, height - inset);
  ctx.closePath();
  ctx.stroke();
}
