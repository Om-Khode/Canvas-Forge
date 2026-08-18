/**
 * Element factories.
 *
 * One function per variant of the `CanvasElement` union. Each takes world-space
 * geometry plus an optional style override and returns a fully-typed, complete
 * element - no partial objects escape this module, so nothing downstream has to
 * defend against a half-built shape.
 *
 * Two things here are less obvious than they look:
 *
 * **Linear and freehand geometry is stored normalized (0..1) inside the bounding
 * box.** That is what lets a line resize and rotate through the exact same
 * transform code as a rectangle - see docs/architecture.md#2.
 */

import { MIN_ELEMENT_SIZE } from '@/constants';
import { nextElementName } from '@/features/elements/names';
import { resolveStyle, type ElementStyle } from '@/features/elements/style';
import type {
  ArrowElement,
  CanvasElement,
  ElementType,
  EllipseElement,
  FreehandElement,
  ImageElement,
  LineElement,
  Rect,
  RectangleElement,
  TextElement,
  Vec2,
  WorldPoint,
  WorldRect,
} from '@/types';
import { normalizeRect as orientRect } from '@/utils/geometry';
import { createId } from '@/utils/id';

export interface CreateElementOptions {
  readonly style?: Partial<ElementStyle>;
  /** The document's current elements; the auto-name suffix is derived from them. */
  readonly existing?: readonly CanvasElement[];
  /** Explicit name, bypassing auto-generation (used by import and duplicate). */
  readonly name?: string;
}

export interface CreateTextOptions extends CreateElementOptions {
  readonly text?: string;
}

export interface CreateImageOptions extends CreateElementOptions {
  readonly imageKey: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly alt?: string;
}

/* ------------------------------------------------------------- geometry -- */

/**
 * Non-negative width/height, and never smaller than a clickable shape.
 *
 * The sign-flip half is `utils/geometry.normalizeRect`; the clamp is the part
 * specific to creation - a drag that ends where it started must still produce
 * something the user can see and grab, rather than a zero-area shape that
 * silently swallows the gesture.
 */
function normalizeRect(rect: Rect): Rect {
  const oriented = orientRect(rect);
  return {
    ...oriented,
    width: Math.max(oriented.width, MIN_ELEMENT_SIZE),
    height: Math.max(oriented.height, MIN_ELEMENT_SIZE),
  };
}

/**
 * Bounding box for a set of points, with the degenerate axis of a perfectly
 * horizontal or vertical stroke widened to `MIN_ELEMENT_SIZE` and re-centred.
 * A zero-height box would make the normalized offsets a division by zero and
 * leave the element impossible to grab.
 */
function boundsOfPoints(points: readonly Vec2[]): Rect {
  const first = points[0] ?? { x: 0, y: 0 };
  let minX = first.x;
  let maxX = first.x;
  let minY = first.y;
  let maxY = first.y;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const width = Math.max(maxX - minX, MIN_ELEMENT_SIZE);
  const height = Math.max(maxY - minY, MIN_ELEMENT_SIZE);
  return {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    width,
    height,
  };
}

function normalizePoint(point: Vec2, bounds: Rect): Vec2 {
  return { x: (point.x - bounds.x) / bounds.width, y: (point.y - bounds.y) / bounds.height };
}

function baseFields(
  type: ElementType,
  rect: Rect,
  options: CreateElementOptions | undefined,
  opacity: number
) {
  return {
    id: createId(),
    name: options?.name ?? nextElementName(type, options?.existing ?? []),
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    rotation: 0,
    opacity,
    locked: false,
    visible: true,
  };
}

/* ------------------------------------------------------------ factories -- */

export function createRectangle(rect: WorldRect, options?: CreateElementOptions): RectangleElement {
  const style = resolveStyle(options?.style);
  const box = normalizeRect(rect);
  return {
    ...baseFields('rectangle', box, options, style.opacity),
    type: 'rectangle',
    fill: style.fill,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    cornerRadius: style.cornerRadius,
  };
}

export function createEllipse(rect: WorldRect, options?: CreateElementOptions): EllipseElement {
  const style = resolveStyle(options?.style);
  const box = normalizeRect(rect);
  return {
    ...baseFields('ellipse', box, options, style.opacity),
    type: 'ellipse',
    fill: style.fill,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
  };
}

/**
 * Lines take two points rather than a rect because the drag *direction* is
 * information a normalized rect has already thrown away: dragging bottom-right
 * to top-left and top-left to bottom-right produce the same box but mirrored
 * endpoints.
 */
export function createLine(
  startWorld: WorldPoint,
  endWorld: WorldPoint,
  options?: CreateElementOptions
): LineElement {
  const style = resolveStyle(options?.style);
  const box = boundsOfPoints([startWorld, endWorld]);
  return {
    ...baseFields('line', box, options, style.opacity),
    type: 'line',
    start: normalizePoint(startWorld, box),
    end: normalizePoint(endWorld, box),
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
  };
}

export function createArrow(
  startWorld: WorldPoint,
  endWorld: WorldPoint,
  options?: CreateElementOptions
): ArrowElement {
  const style = resolveStyle(options?.style);
  const box = boundsOfPoints([startWorld, endWorld]);
  return {
    ...baseFields('arrow', box, options, style.opacity),
    type: 'arrow',
    start: normalizePoint(startWorld, box),
    end: normalizePoint(endWorld, box),
    arrowheadStart: style.arrowheadStart,
    arrowheadEnd: style.arrowheadEnd,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
  };
}

export function createText(rect: WorldRect, options?: CreateTextOptions): TextElement {
  const style = resolveStyle(options?.style);
  const box = normalizeRect(rect);
  // A click-to-place text box has no dragged height; one line of type is the
  // only sensible starting box, and `autoHeight` takes over from there.
  const height = Math.max(box.height, style.fontSize * style.lineHeight);
  return {
    ...baseFields('text', { ...box, height }, options, style.opacity),
    type: 'text',
    text: options?.text ?? '',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    italic: style.italic,
    textAlign: style.textAlign,
    lineHeight: style.lineHeight,
    color: style.color,
    autoHeight: true,
  };
}

export function createImage(rect: WorldRect, options: CreateImageOptions): ImageElement {
  const style = resolveStyle(options.style);
  const box = normalizeRect(rect);
  return {
    ...baseFields('image', box, options, style.opacity),
    type: 'image',
    imageKey: options.imageKey,
    naturalWidth: options.naturalWidth,
    naturalHeight: options.naturalHeight,
    alt: options.alt ?? '',
  };
}

export function createFreehand(
  points: readonly WorldPoint[],
  options?: CreateElementOptions
): FreehandElement {
  const style = resolveStyle(options?.style);
  const box = boundsOfPoints(points);
  return {
    ...baseFields('freehand', box, options, style.opacity),
    type: 'freehand',
    points: points.map((point) => normalizePoint(point, box)),
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
  };
}

/*
 * Re-exported so `@/features/elements/factory` stays the single import site for
 * "make me an element", whether that means building one from geometry or
 * copying one that already exists. The implementations live next door because
 * they are separable concerns, not because callers should have to know that.
 */
export {
  ARROWHEAD_SIZE,
  DEFAULT_ELEMENT_STYLE,
  resolveStyle,
  type ElementStyle,
} from '@/features/elements/style';
export { cloneElements, type CloneResult } from '@/features/elements/clone';
export { createGroup } from '@/features/elements/group';
export { ELEMENT_TYPE_LABEL, nextElementName } from '@/features/elements/names';
