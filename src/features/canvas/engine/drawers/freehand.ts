import type { FreehandElement, Vec2 } from '@/types';
import { configureStroke, type Drawer } from './shared';

export const drawFreehand: Drawer<FreehandElement> = (ctx, element) => {
  if (!configureStroke(ctx, element)) return;

  const points = toLocalPoints(element);
  if (points.length === 0) return;

  const first = points[0];
  if (first === undefined) return;

  // A tap produces one sample. Stroking a zero-length path draws nothing even
  // with a round cap on some backends, so a dot is drawn explicitly.
  if (points.length === 1) {
    if (element.stroke === null) return;
    ctx.beginPath();
    ctx.arc(first.x, first.y, element.strokeWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = element.stroke;
    ctx.fill();
    return;
  }

  // Dashes fight the smoothing and make a pen stroke look like a border.
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);

  if (points.length === 2) {
    const second = points[1];
    if (second !== undefined) ctx.lineTo(second.x, second.y);
    ctx.stroke();
    return;
  }

  /*
   * Midpoint quadratic smoothing.
   *
   * Pointer samples arrive as a polyline with a visible corner at every sample,
   * which at 120Hz is a lot of corners. The fix, without pulling in a spline
   * library or solving for tangents:
   *
   *   - Take each *sample* p[i] as a Bézier control point.
   *   - Take the *midpoint* of p[i] and p[i+1] as the curve's endpoint.
   *
   * A quadratic Bézier is tangent to the control polygon at both ends, so
   * consecutive segments share both a position (the midpoint) and a direction
   * (the segment p[i]→p[i+1]). That gives C¹ continuity for free - no linear
   * system, no tangent estimation, ~10 lines.
   *
   * The trade is that the curve no longer passes through the interior samples;
   * it passes through the midpoints instead, pulling corners in by at most half
   * a sample spacing. For a hand-drawn stroke that reads as smoothing, which is
   * the point.
   */
  for (let i = 1; i < points.length - 1; i += 1) {
    const control = points[i];
    const next = points[i + 1];
    if (control === undefined || next === undefined) continue;
    ctx.quadraticCurveTo(control.x, control.y, (control.x + next.x) / 2, (control.y + next.y) / 2);
  }

  // The final sample is a control point with no successor to average with, so
  // the tail is closed with a straight segment to it. Half a sample of
  // straightness at the very end is imperceptible.
  const last = points[points.length - 1];
  if (last !== undefined) ctx.lineTo(last.x, last.y);

  ctx.stroke();
};

/**
 * Points are stored normalized (0..1) inside the bounding box so a freehand
 * stroke resizes and rotates through the same box transform as every other
 * element, instead of needing every point rewritten on each drag.
 */
function toLocalPoints(element: FreehandElement): Vec2[] {
  const local: Vec2[] = [];
  for (const point of element.points) {
    local.push({ x: point.x * element.width, y: point.y * element.height });
  }
  return local;
}
