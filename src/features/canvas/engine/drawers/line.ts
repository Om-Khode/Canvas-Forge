import type { LineElement } from '@/types';
import { configureStroke, resolveEndpoints, type Drawer } from './shared';

export const drawLine: Drawer<LineElement> = (ctx, element) => {
  if (!configureStroke(ctx, element)) return;

  const { start, end } = resolveEndpoints(element);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
};
