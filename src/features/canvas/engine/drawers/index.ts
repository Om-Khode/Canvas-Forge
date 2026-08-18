/**
 * Element drawer dispatch.
 *
 * Every drawer paints in the element's **local space**: origin at the top-left
 * of its unrotated box, x to `width`, y to `height`, no rotation and no zoom.
 * The renderer has already pushed the element's matrix onto the context, so a
 * drawer that reads `element.x` or `element.rotation` is a bug - it would apply
 * the transform twice.
 *
 * Adding an element type is one file plus one case here. The `assertNever` in
 * the default branch turns "forgot to draw the new type" from a blank shape at
 * runtime into a compile error.
 */

import { assertNever, type CanvasElement } from '@/types';
import { drawArrow } from './arrow';
import { drawEllipse } from './ellipse';
import { drawFreehand } from './freehand';
import { drawGroup } from './group';
import { drawImage } from './image';
import { drawLine } from './line';
import { drawRectangle } from './rectangle';
import { drawText } from './text';
import type { DrawerDeps } from './shared';

export function drawElement(
  ctx: CanvasRenderingContext2D,
  element: CanvasElement,
  deps: DrawerDeps
): void {
  switch (element.type) {
    case 'rectangle':
      drawRectangle(ctx, element, deps);
      return;
    case 'ellipse':
      drawEllipse(ctx, element, deps);
      return;
    case 'line':
      drawLine(ctx, element, deps);
      return;
    case 'arrow':
      drawArrow(ctx, element, deps);
      return;
    case 'text':
      drawText(ctx, element, deps);
      return;
    case 'image':
      drawImage(ctx, element, deps);
      return;
    case 'freehand':
      drawFreehand(ctx, element, deps);
      return;
    case 'group':
      drawGroup();
      return;
    default:
      assertNever(element, 'element type');
  }
}

export type { Drawer, DrawerDeps } from './shared';
export { fontString, measureTextBlock, wrapText } from './text';
export type { TextLayout, TextMeasurer } from './text';
