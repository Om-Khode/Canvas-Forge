/**
 * The canvas's CSS size and the device pixel ratio to back it with.
 *
 * Two separate signals that both change the backing store, and both are easy to
 * get wrong in ways that only show on someone else's machine:
 *
 *  - **Size** comes from a `ResizeObserver` on the container, not from a window
 *    `resize` listener. Panels collapsing, a sidebar opening, or the toolbar
 *    wrapping all change the canvas's size without the window changing at all.
 *  - **DPR** is not constant. Drag the window from a retina laptop screen to a
 *    1× external monitor and `devicePixelRatio` goes 2 → 1 with no resize event
 *    and no media-query you can name up front. The trick is to match on the
 *    *current* ratio - `(resolution: 2dppx)` - and re-subscribe when that query
 *    stops matching, which is the only reliable notification the platform gives.
 */

import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { useCanvasStore } from '@/store';

export interface CanvasSize {
  /** CSS pixels. What the drawing code works in. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

interface CssSize {
  readonly width: number;
  readonly height: number;
}

const INITIAL_SIZE: CssSize = { width: 0, height: 0 };

export function useCanvasSize(containerRef: RefObject<HTMLElement | null>): CanvasSize {
  const [size, setSize] = useState<CssSize>(INITIAL_SIZE);
  const [dpr, setDpr] = useState(() => currentDpr());

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setSize((previous) =>
        // Sub-pixel container sizes are rounded, so a layout that settles at
        // 640.0001px doesn't re-allocate the backing store every frame.
        previous.width === Math.round(width) && previous.height === Math.round(height)
          ? previous
          : { width: Math.round(width), height: Math.round(height) }
      );
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = (): void => {
      setDpr(currentDpr());
    };
    query.addEventListener('change', onChange);
    // The effect re-runs on every DPR change, building a query for the *new*
    // ratio. That self-rearming is the whole mechanism - a single fixed query
    // would only ever fire once.
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [dpr]);

  useEffect(() => {
    // The store keeps the viewport size because "zoom to fit", centre-anchored
    // zoom, and culling all need it, and threading it through every call site
    // would be worse. Written imperatively - nothing here subscribes to it.
    useCanvasStore.getState().setViewportSize(size.width, size.height);
  }, [size.width, size.height]);

  return { width: size.width, height: size.height, dpr };
}

/**
 * Guarded rather than read directly: the DOM lib types this as always-present
 * `number`, but jsdom and some embedded webviews leave it undefined, and a
 * backing store sized `width * undefined` is a blank canvas with no error.
 */
function currentDpr(): number {
  return window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}
