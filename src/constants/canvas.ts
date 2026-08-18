/** Viewport, interaction, and overlay tuning. No magic numbers in feature code. */

/**
 * Below ~2% a design is a smear of sub-pixels; above 64x the float error in the
 * viewport transform becomes visible as jitter while panning.
 */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
export const DEFAULT_ZOOM = 1;

/** Discrete steps for the +/- controls, so repeated clicks land on round numbers. */
export const ZOOM_STEPS = [
  0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 16, 32, 64,
] as const;

/** Multiplier per wheel notch. Chosen to feel responsive without overshooting. */
export const ZOOM_WHEEL_SENSITIVITY = 0.0015;

/** Padding (fraction of the viewport) left around content by "zoom to fit". */
export const ZOOM_TO_FIT_PADDING = 0.1;

/** World-space spacing of the background dot grid at 100% zoom. */
export const GRID_SIZE = 24;

/**
 * The grid stops being drawn below this zoom - the dots would be denser than
 * the pixel grid, which costs a lot of draw calls to produce visual noise.
 */
export const GRID_MIN_VISIBLE_ZOOM = 0.35;
export const GRID_DOT_RADIUS = 1;

/**
 * Pointer must travel this far (screen px) before a press becomes a drag.
 * Without it, a click with 1px of hand tremor creates an undoable move.
 */
export const DRAG_THRESHOLD_PX = 3;

/** Selection chrome, in *screen* pixels - drawn un-zoomed so it stays constant. */
export const HANDLE_SIZE_PX = 8;
export const HANDLE_HIT_PADDING_PX = 4;
export const ROTATION_HANDLE_OFFSET_PX = 22;
export const SELECTION_OUTLINE_WIDTH_PX = 1.5;

/** Extra click tolerance around thin strokes, in screen px (scaled by 1/zoom). */
export const STROKE_HIT_TOLERANCE_PX = 6;

/** Rotation snaps to multiples of this (radians) while Shift is held. */
export const ROTATION_SNAP_RADIANS = Math.PI / 12; // 15°

/**
 * Rotations closer than this (radians) count as the same angle.
 *
 * The properties panel's angle field shows degrees to one decimal, so the
 * smallest edit it can express is ~1e-3 rad. Anything below this tolerance is
 * float residue from a degrees round trip, and treating it as an edit would cost
 * an undo entry for re-typing the value already on screen.
 */
export const ROTATION_NOOP_RADIANS = 1e-9;

/** Minimum element extent in world units - prevents zero-area, unselectable shapes. */
export const MIN_ELEMENT_SIZE = 1;

/** A drag-out smaller than this is treated as a click-to-place default shape. */
export const CLICK_TO_PLACE_THRESHOLD = 4;
export const DEFAULT_SHAPE_SIZE = 120;

/** Offset applied to pasted and duplicated elements so they don't hide the original. */
export const PASTE_OFFSET = 16;
