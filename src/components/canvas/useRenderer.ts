/**
 * Binds the pure `Renderer` to the store and the image cache.
 *
 * This hook is the entire React↔engine seam, and it is deliberately one-way:
 * nothing here calls `useCanvasStore(selector)`, so no store write can re-render
 * the component that owns the canvas. Updates travel
 *
 *     store.setState → subscribe callback → markDirty() → rAF → getScene()
 *
 * which never touches the reconciler. That is the central performance claim of
 * the project (docs/architecture.md §5, §11); using the selector hook here would
 * quietly undo all of it.
 *
 * `getScene` is a *pull*, not a push. The renderer asks for the scene at the top
 * of each frame, so ten store writes between two frames produce one read and one
 * paint - and the same getter shape is what lets PNG export point a second
 * Renderer at an offscreen canvas.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Renderer } from '@/features/canvas/engine/Renderer';
import type { RenderScene } from '@/features/canvas/engine/scene';
import { refreshTheme } from '@/features/canvas/engine/theme';
import { subscribeTheme } from '@/hooks/useTheme';
// `resolveImage` is exported bare alongside the store for exactly this: handing
// the renderer a plain function keeps the scene getter free of a method call
// whose `this` would have to survive being passed around.
import { elementsToPaint } from '@/features/elements/tree';
import { imageStore, resolveImage } from '@/services/imageStore';
import { useCanvasStore } from '@/store';
import type { CanvasStore } from '@/store';
import type { CanvasElement, ElementStore } from '@/types';
import type { CanvasSize } from './useCanvasSize';

export function useRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  size: CanvasSize
): void {
  const rendererRef = useRef<Renderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const orderCache = createOrderCache();
    const renderer = new Renderer(canvas, (): RenderScene => {
      const state = useCanvasStore.getState();
      return {
        elements: orderCache(state.elements),
        viewport: state.viewport,
        selectedIds: state.selection,
        interaction: state.interaction,
        resolveImage,
      };
    });
    rendererRef.current = renderer;

    const unsubscribeStore = useCanvasStore.subscribe((state, previous) => {
      // The store also carries dialog state, save status, and the project name,
      // none of which the renderer draws. Comparing the four fields it does read
      // is four pointer comparisons and saves a wasted frame on every UI change.
      if (!affectsPaint(state, previous)) return;
      renderer.markDirty();
    });

    // A decode landing is the one repaint trigger that does not come from a
    // store write: the element never changed, only the pixels behind its key.
    const unsubscribeImages = imageStore.subscribe(() => {
      renderer.markDirty();
    });

    /*
     * A theme flip changes nothing in the store, so neither subscription above
     * fires - but the canvas background and dot grid are read from CSS custom
     * properties and cached by the engine. Without this the chrome around the
     * canvas re-themes instantly while the canvas itself keeps the old palette
     * until a reload, which reads as a rendering bug rather than a stale cache.
     */
    const unsubscribeTheme = subscribeTheme(() => {
      refreshTheme();
      renderer.markDirty();
    });

    renderer.markDirty();

    return () => {
      unsubscribeStore();
      unsubscribeImages();
      unsubscribeTheme();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [canvasRef]);

  useEffect(() => {
    // `resize` reallocates the backing store, which resets every context
    // property, so the renderer marks itself dirty and repaints from scratch.
    rendererRef.current?.resize(size.width, size.height, size.dpr);
  }, [size.width, size.height, size.dpr]);
}

function affectsPaint(state: CanvasStore, previous: CanvasStore): boolean {
  return (
    state.elements !== previous.elements ||
    state.viewport !== previous.viewport ||
    state.selection !== previous.selection ||
    state.interaction !== previous.interaction
  );
}

/**
 * Resolves the document into a flat paint list, memoized on its identity.
 *
 * `elementsToPaint` rather than `elementsInOrder`: `order` holds root ids only,
 * so a root-level walk cannot see a group's members at all and grouping
 * anything would make it vanish from the canvas. The same walk is where an
 * ancestor's opacity, visibility and lock are folded into each member, because
 * the scene contract hands the engine a flat array with no view of the tree.
 *
 * The elements slice returns the *same* `ElementStore` object when a change was
 * a no-op, so panning and zooming - which do not touch the document - reuse the
 * array instead of rebuilding it once per frame. During a drag the document
 * genuinely changes every frame and the cache misses every frame, which is
 * correct: there is nothing to reuse.
 */
function createOrderCache(): (document: ElementStore) => readonly CanvasElement[] {
  let lastDocument: ElementStore | null = null;
  let lastResult: readonly CanvasElement[] = [];

  return (document) => {
    if (document !== lastDocument) {
      lastDocument = document;
      lastResult = elementsToPaint(document);
    }
    return lastResult;
  };
}
