/**
 * The flattened style record.
 *
 * Every style property any element variant can carry, in one shape. The tool
 * slice keeps one of these per drawing tool so the rectangle tool can remember
 * a different fill from the ellipse tool; a factory reads only the keys its
 * variant actually has.
 *
 * One flat record rather than a per-variant style union: the properties panel
 * edits "the current style" without caring which tool is active, and a union
 * would make every read a discriminated switch for no gain - the extra keys on
 * a variant that ignores them cost nothing.
 */

import {
  DEFAULT_ARROWHEAD_SIZE,
  DEFAULT_CORNER_RADIUS,
  DEFAULT_FILL,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_OPACITY,
  DEFAULT_STROKE,
  DEFAULT_STROKE_STYLE,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_TEXT_COLOR,
} from '@/constants';
import type { ArrowheadStyle, FontWeight, StrokeStyle, TextAlign } from '@/types';

export interface ElementStyle {
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly strokeWidth: number;
  readonly strokeStyle: StrokeStyle;
  readonly opacity: number;
  readonly cornerRadius: number;
  readonly arrowheadStart: ArrowheadStyle;
  readonly arrowheadEnd: ArrowheadStyle;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: FontWeight;
  readonly italic: boolean;
  readonly textAlign: TextAlign;
  readonly lineHeight: number;
  readonly color: string;
}

export const DEFAULT_ELEMENT_STYLE: ElementStyle = {
  fill: DEFAULT_FILL,
  stroke: DEFAULT_STROKE,
  strokeWidth: DEFAULT_STROKE_WIDTH,
  strokeStyle: DEFAULT_STROKE_STYLE,
  opacity: DEFAULT_OPACITY,
  cornerRadius: DEFAULT_CORNER_RADIUS,
  arrowheadStart: 'none',
  arrowheadEnd: 'triangle',
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  fontWeight: DEFAULT_FONT_WEIGHT,
  italic: false,
  textAlign: DEFAULT_TEXT_ALIGN,
  lineHeight: DEFAULT_LINE_HEIGHT,
  color: DEFAULT_TEXT_COLOR,
};

/**
 * Arrowheads are sized from a constant rather than the style record because
 * nothing in the UI exposes it yet; re-exported here so the constant has one
 * owner if that changes.
 */
export const ARROWHEAD_SIZE = DEFAULT_ARROWHEAD_SIZE;

export function resolveStyle(override: Partial<ElementStyle> | undefined): ElementStyle {
  return override === undefined ? DEFAULT_ELEMENT_STYLE : { ...DEFAULT_ELEMENT_STYLE, ...override };
}
