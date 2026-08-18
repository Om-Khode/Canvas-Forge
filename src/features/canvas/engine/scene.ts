/**
 * The contract between the renderer and whoever owns the data.
 *
 * The renderer is constructed with a `() => RenderScene` getter, so it holds no
 * reference to the store, no subscription, and no React anything - it asks for
 * the current scene at the top of each frame and paints it. Three payoffs:
 *
 *   - PNG export reuses the renderer verbatim. Build a `RenderScene` with a
 *     fitted viewport and an empty selection, point a Renderer at an offscreen
 *     canvas, call `renderNow()`. No second rendering path to keep in sync with
 *     the first, which is the usual way exported images drift from the screen.
 *   - Tests can drive a frame from a literal object.
 *   - The store can be replaced without the engine noticing.
 *
 * `resolveImage` is a function rather than a map because decoding is async and
 * cache-backed: the renderer asks per frame and gets `null` until the decode
 * lands, at which point the owner marks the renderer dirty. The renderer never
 * awaits anything.
 */

import type { CanvasElement, ElementId, InteractionState, Viewport } from '@/types';

/**
 * What the renderer paints *besides* the document.
 *
 * On screen, the dot grid and the page-coloured backdrop are the canvas; in an
 * exported file they are decoration the user did not draw, and a "transparent
 * PNG" that arrives with an opaque backdrop is simply wrong. Making this part
 * of the scene rather than a renderer flag keeps the renderer a pure function
 * of its input - the export path builds a different scene, not a different
 * renderer in a different global state.
 */
export interface SceneChrome {
  /** Fill the surface with the canvas background before drawing. */
  readonly background: boolean;
  readonly grid: boolean;
  /** Selection outlines, handles, marquee. Never wanted in an export. */
  readonly overlay: boolean;
}

export const SCREEN_CHROME: SceneChrome = { background: true, grid: true, overlay: true };

/** Document only. What every export path wants. */
export const BARE_CHROME: SceneChrome = { background: false, grid: false, overlay: false };

export interface RenderScene {
  /** Already in paint order, bottom → top. Resolving `elementOrder` is the caller's job. */
  readonly elements: readonly CanvasElement[];
  readonly viewport: Viewport;
  readonly selectedIds: ReadonlySet<ElementId>;
  readonly interaction: InteractionState;
  readonly resolveImage: (imageKey: string) => CanvasImageSource | null;
  /** Omitted means `SCREEN_CHROME` - the on-screen editor is the default caller. */
  readonly chrome?: SceneChrome;
  /**
   * Painted under the document when `chrome.background` is false. `null` leaves
   * the surface transparent, which is the whole point of the option.
   */
  readonly backgroundColor?: string | null;
}

/** A scene getter. What the renderer is actually handed. */
export type SceneSource = () => RenderScene;

/**
 * An empty scene, for a renderer mounted before the document has loaded and as
 * a base for tests and export callers that only need to override a field or two.
 */
export function emptyScene(viewport: Viewport): RenderScene {
  return {
    elements: [],
    viewport,
    selectedIds: new Set<ElementId>(),
    interaction: { kind: 'idle' },
    resolveImage: () => null,
  };
}
