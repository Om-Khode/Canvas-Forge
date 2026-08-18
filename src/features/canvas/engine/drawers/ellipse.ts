import type { EllipseElement } from '@/types';
import { configureFill, configureStroke, type Drawer } from './shared';

/**
 * An ellipse inscribed in the element's box - centre at the box centre, radii
 * at half its extents. That convention (rather than centre-and-radius storage)
 * is what lets an ellipse share every resize, rotate, and alignment code path
 * with a rectangle.
 */
export const drawEllipse: Drawer<EllipseElement> = (ctx, element) => {
  const radiusX = element.width / 2;
  const radiusY = element.height / 2;

  ctx.beginPath();
  ctx.ellipse(radiusX, radiusY, Math.abs(radiusX), Math.abs(radiusY), 0, 0, Math.PI * 2);

  if (configureFill(ctx, element)) ctx.fill();
  if (configureStroke(ctx, element)) ctx.stroke();
};
