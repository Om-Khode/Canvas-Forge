import type { RectangleElement } from '@/types';
import { configureFill, configureStroke, roundedRectPath, type Drawer } from './shared';

/**
 * Fill first, then stroke.
 *
 * Canvas strokes straddle the path - half the width falls inside, half outside
 * - so painting the fill afterwards would eat the inner half of the border and
 * make a 2px stroke look like 1px.
 */
export const drawRectangle: Drawer<RectangleElement> = (ctx, element) => {
  roundedRectPath(ctx, element.width, element.height, element.cornerRadius);

  if (configureFill(ctx, element)) ctx.fill();
  if (configureStroke(ctx, element)) ctx.stroke();
};
