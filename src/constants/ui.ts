/** Panel and list geometry that JavaScript has to agree with CSS about. */

/**
 * Height of one layer row, in CSS pixels. Must match the `h-8` on `LayerRow`.
 *
 * Windowing needs a row height it can multiply, and measuring one row to
 * discover it would mean a layout read before the first paint - so the number
 * is stated once here and asserted against the DOM in a test, rather than
 * being duplicated as a literal in the hook.
 */
export const LAYER_ROW_HEIGHT = 32;

/** Vertical padding inside the layers list, matching its `py-1`. */
export const LAYER_LIST_PADDING = 4;

/**
 * Horizontal indent per level of group nesting, in CSS pixels.
 *
 * Nesting is padding, not nested containers: windowing is arithmetic only while
 * every row is the same box at the same height, so a row inside a group is the
 * root row shifted right rather than a row inside something.
 */
export const LAYER_INDENT_PX = 14;

/** Left inset of a root-level row, before any indent is added. */
export const LAYER_ROW_INSET_PX = 4;

/**
 * Rows rendered beyond each edge of the viewport.
 *
 * Six is roughly a fifth of a screenful here. Enough that a fast flick does not
 * expose blank space before the next frame lands, few enough that the DOM stays
 * small - the entire point of the exercise.
 */
export const LAYER_OVERSCAN = 6;

/** Distance from a list edge at which a drag starts auto-scrolling. */
export const LAYER_AUTOSCROLL_MARGIN = 28;
/** Pixels per frame at the very edge; scales down to zero across the margin. */
export const LAYER_AUTOSCROLL_MAX_SPEED = 14;
