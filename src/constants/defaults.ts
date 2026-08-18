/** Default paint properties for newly created elements. */

import type { FontWeight, StrokeStyle, TextAlign } from '@/types';

/**
 * A restrained, high-contrast set. Design tools live or die on whether the
 * default output looks deliberate, so these are picked as a palette rather
 * than sampled from a colour wheel.
 */
export const SWATCHES = [
  '#1c1c1f',
  '#6b7280',
  '#c2603f',
  '#d99a2b',
  '#3f7d58',
  '#3b6fa8',
  '#6b4f9e',
  '#b04a6a',
  '#ffffff',
] as const;

export const DEFAULT_FILL = '#e8e6e1';
export const DEFAULT_STROKE = '#1c1c1f';
export const DEFAULT_STROKE_WIDTH = 2;
export const DEFAULT_STROKE_STYLE: StrokeStyle = 'solid';
export const DEFAULT_OPACITY = 1;
export const DEFAULT_CORNER_RADIUS = 4;

export const STROKE_WIDTHS = [1, 2, 4, 8] as const;

/** Dash patterns in world units, scaled by stroke width at draw time. */
export const STROKE_DASH_PATTERNS: Record<StrokeStyle, readonly number[]> = {
  solid: [],
  dashed: [4, 3],
  dotted: [0.5, 2.5],
};

export const DEFAULT_TEXT_COLOR = '#1c1c1f';
export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_FONT_WEIGHT: FontWeight = 400;
export const DEFAULT_TEXT_ALIGN: TextAlign = 'left';
export const DEFAULT_LINE_HEIGHT = 1.35;

export const FONT_SIZES = [12, 14, 16, 20, 24, 32, 48, 64, 96] as const;
export const FONT_WEIGHTS: readonly FontWeight[] = [400, 500, 600, 700];

/**
 * Font stacks rather than single families: the canvas measures whatever the
 * browser actually resolves, so a stack degrades gracefully instead of
 * silently shifting metrics when a family is missing.
 */
export const FONT_FAMILIES = [
  { label: 'Sans', value: "'Inter Variable', system-ui, sans-serif" },
  { label: 'Serif', value: "'Iowan Old Style', Georgia, serif" },
  { label: 'Mono', value: "ui-monospace, 'Cascadia Mono', monospace" },
] as const;

export const DEFAULT_FONT_FAMILY = FONT_FAMILIES[0].value;

export const DEFAULT_ARROWHEAD_SIZE = 12;

/** Images larger than this on their long edge are downscaled before storage. */
export const MAX_IMAGE_DIMENSION = 2400;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * The allow-list for uploads *and* for data URIs arriving in an imported
 * project file, which is untrusted input.
 *
 * `image/svg+xml` is the one entry that deserves an argument, because SVG is the
 * only raster-adjacent format that can carry `<script>`. It is included, and the
 * reasoning is worth stating precisely rather than waving at:
 *
 *  - Every image in this app reaches the screen through `new Image()` and
 *    `drawImage`. Script inside an SVG loaded as an image does not execute -
 *    that is a specified browser behaviour, not an accident of implementation.
 *  - The blob is same-origin, so drawing it does not taint the canvas, which is
 *    what keeps `toBlob` working for PNG export.
 *
 * The exposure this leaves is conditional, and it is the part to remember: the
 * safety rests on SVG never being inlined into the DOM. If a future change ever
 * renders one through `innerHTML`, an `<object>`, or a same-origin iframe - a
 * thumbnail view, say, or an SVG-preserving export preview - this becomes a
 * stored-XSS vector immediately. Anyone making that change must either sanitise
 * or drop this entry.
 *
 * The one-line hardening, if the format is not worth the caveat, is to delete
 * the last line.
 */
export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;
