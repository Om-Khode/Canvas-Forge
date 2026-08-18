/**
 * The document element model.
 *
 * A discriminated union on `type`. Every consumer switches on that field and
 * ends with `assertNever`, so adding a variant produces a compile error at each
 * place that must learn to handle it - rather than a silent runtime gap.
 */

import type { Vec2 } from './geometry';

export type ElementId = string;

export type ElementType =
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'image'
  | 'freehand'
  | 'group';

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type ArrowheadStyle = 'none' | 'triangle' | 'line';
export type TextAlign = 'left' | 'center' | 'right';
export type FontWeight = 400 | 500 | 600 | 700;

/**
 * Fields every element carries.
 *
 * `x`/`y` are the top-left corner of the *unrotated* bounding box in world
 * space; `rotation` is applied about the box's centre at draw and hit-test
 * time. Keeping position unrotated means move, resize, and alignment all
 * operate on plain axis-aligned numbers and only the transform stack deals
 * with the angle.
 *
 * There is deliberately no `zIndex`. Depth is the element's index in
 * `Project.elementOrder`; a per-element number would allow duplicates and gaps,
 * which are states the UI would then have to defend against.
 */
export interface BaseElement {
  readonly id: ElementId;
  readonly type: ElementType;
  /** User-facing label in the layers panel. Auto-generated, renameable. */
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Radians, clockwise, about the element's centre. */
  readonly rotation: number;
  /** 0..1 */
  readonly opacity: number;
  readonly locked: boolean;
  readonly visible: boolean;
}

/** Shared paint properties for the shape variants. */
export interface StrokeProps {
  /** CSS colour, or `null` for no stroke. */
  readonly stroke: string | null;
  readonly strokeWidth: number;
  readonly strokeStyle: StrokeStyle;
}

export interface FillProps {
  /** CSS colour, or `null` for a hollow shape. */
  readonly fill: string | null;
}

export interface RectangleElement extends BaseElement, StrokeProps, FillProps {
  readonly type: 'rectangle';
  /** World units. Clamped at draw time to half the shorter side. */
  readonly cornerRadius: number;
}

export interface EllipseElement extends BaseElement, StrokeProps, FillProps {
  readonly type: 'ellipse';
}

/**
 * Lines and arrows still carry a bounding box, because selection, marquee
 * hit-testing, and alignment all need one. The endpoints are stored as
 * *normalized* offsets (0..1) within that box, so resizing and rotating a line
 * runs through exactly the same transform code as a rectangle - one
 * implementation instead of a special case.
 */
export interface LineElement extends BaseElement, StrokeProps {
  readonly type: 'line';
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface ArrowElement extends BaseElement, StrokeProps {
  readonly type: 'arrow';
  readonly start: Vec2;
  readonly end: Vec2;
  readonly arrowheadStart: ArrowheadStyle;
  readonly arrowheadEnd: ArrowheadStyle;
}

export interface TextElement extends BaseElement {
  readonly type: 'text';
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: FontWeight;
  readonly italic: boolean;
  readonly textAlign: TextAlign;
  /** Multiplier of font size, not an absolute value - survives font-size edits. */
  readonly lineHeight: number;
  readonly color: string;
  /**
   * When true the box height tracks the wrapped content instead of being set
   * by the user. Dragging a vertical resize handle switches this off.
   */
  readonly autoHeight: boolean;
}

export interface ImageElement extends BaseElement {
  /**
   * Holds a *key* into the image blob store, never pixel data. Keeps history
   * snapshots and the store small - see docs/architecture.md#images.
   */
  readonly type: 'image';
  readonly imageKey: string;
  /** Intrinsic pixel dimensions, kept so aspect ratio survives a reload. */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  /** Falls back to the filename; used as the accessible label. */
  readonly alt: string;
}

/** A pointer-captured stroke. Points are normalized (0..1) within the bounding box. */
export interface FreehandElement extends BaseElement, StrokeProps {
  readonly type: 'freehand';
  readonly points: readonly Vec2[];
}

/**
 * A container. Children keep world coordinates; a group has no transform of its
 * own, and its `x`/`y`/`width`/`height` are a derived cache of the union of its
 * descendants. `rotation` is always 0 - rotating a group turns the children and
 * leaves the group's box axis-aligned.
 */
export interface GroupElement extends BaseElement {
  readonly type: 'group';
  /** Members, bottom-to-top within the group. */
  readonly childIds: readonly ElementId[];
}

export type CanvasElement =
  | RectangleElement
  | EllipseElement
  | LineElement
  | ArrowElement
  | TextElement
  | ImageElement
  | FreehandElement
  | GroupElement;

/** Variants that have a fill. Narrows without repeating the union. */
export type FillableElement = Extract<CanvasElement, FillProps>;

/** Variants that have a stroke. */
export type StrokableElement = Extract<CanvasElement, StrokeProps>;

/** Variants defined by two endpoints. */
export type LinearElement = LineElement | ArrowElement;

/**
 * Exhaustiveness guard. Placed in the `default` branch of a switch over
 * `element.type`; if a new variant is added the argument stops being `never`
 * and the file fails to compile.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
