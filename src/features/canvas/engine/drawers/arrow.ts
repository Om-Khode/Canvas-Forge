import { DEFAULT_ARROWHEAD_SIZE } from '@/constants';
import type { ArrowElement, ArrowheadStyle, Vec2 } from '@/types';
import { configureStroke, resolveEndpoints, type Drawer } from './shared';

/**
 * Half-angle between the shaft and each barb. π/7 ≈ 25.7°, giving a ~51° head:
 * narrow enough to read as a direction indicator rather than a triangle, wide
 * enough to stay legible when the arrow is only a few pixels long on screen.
 */
const ARROWHEAD_HALF_ANGLE = Math.PI / 7;

/**
 * A head may consume at most this fraction of the shaft. Without the clamp a
 * short arrow - the common case when someone drags one out by accident - is
 * two overlapping heads and no visible line.
 */
const ARROWHEAD_MAX_SHAFT_FRACTION = 0.4;

/**
 * Heads grow slightly with stroke weight. A fixed-size head on an 8px stroke
 * looks like a blunt stub, because the stroke's own round cap already occupies
 * most of it.
 */
const ARROWHEAD_STROKE_SCALE = 1.5;

export const drawArrow: Drawer<ArrowElement> = (ctx, element) => {
  if (!configureStroke(ctx, element)) return;

  const { start, end } = resolveEndpoints(element);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const shaftLength = Math.hypot(dx, dy);
  if (shaftLength === 0) return;

  // Unit vector pointing start → end. Every head is expressed relative to the
  // direction it points *into*, so the tail head just negates this.
  const forward: Vec2 = { x: dx / shaftLength, y: dy / shaftLength };
  const backward: Vec2 = { x: -forward.x, y: -forward.y };

  const headSize = Math.min(
    DEFAULT_ARROWHEAD_SIZE + element.strokeWidth * ARROWHEAD_STROKE_SCALE,
    shaftLength * ARROWHEAD_MAX_SHAFT_FRACTION
  );

  // A filled triangle covers the shaft up to its base, so the shaft is pulled
  // back to that base. Otherwise the shaft's round cap protrudes past the tip
  // as a small nub - visible at high zoom and on thick strokes.
  const inset = headSize * Math.cos(ARROWHEAD_HALF_ANGLE);
  const shaftStart = insetPoint(start, forward, element.arrowheadStart === 'triangle' ? inset : 0);
  const shaftEnd = insetPoint(end, backward, element.arrowheadEnd === 'triangle' ? inset : 0);

  ctx.beginPath();
  ctx.moveTo(shaftStart.x, shaftStart.y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();

  // Heads are solid even when the shaft is dashed - a dashed arrowhead is
  // noise, not information.
  ctx.setLineDash([]);
  drawHead(ctx, element.arrowheadStart, start, backward, headSize, element.stroke);
  drawHead(ctx, element.arrowheadEnd, end, forward, headSize, element.stroke);
};

function insetPoint(point: Vec2, towards: Vec2, distance: number): Vec2 {
  return { x: point.x + towards.x * distance, y: point.y + towards.y * distance };
}

/**
 * `direction` is the unit vector the head points along. The two barbs sit one
 * `size` back from the tip, rotated ±`ARROWHEAD_HALF_ANGLE` off that axis - so
 * the head's outline is an isosceles triangle with legs of length `size`,
 * independent of the shaft's angle.
 */
function drawHead(
  ctx: CanvasRenderingContext2D,
  style: ArrowheadStyle,
  tip: Vec2,
  direction: Vec2,
  size: number,
  color: string | null
): void {
  if (style === 'none' || color === null) return;

  const left = barb(tip, direction, size, ARROWHEAD_HALF_ANGLE);
  const right = barb(tip, direction, size, -ARROWHEAD_HALF_ANGLE);

  ctx.beginPath();
  if (style === 'triangle') {
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }

  // 'line' - an open V, drawn as two strokes meeting at the tip.
  ctx.moveTo(left.x, left.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(right.x, right.y);
  ctx.stroke();
}

function barb(tip: Vec2, direction: Vec2, size: number, angle: number): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Rotate `direction` by `angle`, then step backwards from the tip along it.
  const rotatedX = direction.x * cos - direction.y * sin;
  const rotatedY = direction.x * sin + direction.y * cos;
  return { x: tip.x - rotatedX * size, y: tip.y - rotatedY * size };
}
