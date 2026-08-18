/**
 * Fixed-height row windowing.
 *
 * The layers panel renders one row per element, and at 2,000 elements that was
 * 45,221 DOM nodes and a 979ms mount (`docs/performance.md`). Worse than the
 * mount cost: a document that large made *unrelated* style writes elsewhere on
 * the page expensive, because every one of them invalidated pre-paint across
 * the whole tree. It was the one part of the architecture that did not survive
 * its own stated target scale.
 *
 * Every row is exactly `rowHeight` tall, which is what makes this ~40 lines
 * instead of a library: the visible range is division, not measurement. No
 * per-row observers, no cumulative offset cache, no dynamic remeasurement.
 *
 * **The unmeasured case renders everything, deliberately.** Before the first
 * layout - and under jsdom, which has no layout at all - the viewport height
 * reads as 0. Windowing on that would render an empty list, which would make
 * every existing panel test pass vacuously while the real component showed
 * nothing. Falling back to the full range means the untested path is the one
 * that renders *more*, never less.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface VirtualWindow {
  /** First index to render. */
  readonly start: number;
  /** One past the last index to render. */
  readonly end: number;
  /** Scroll height the sizer must reserve for the full list. */
  readonly totalHeight: number;
  /** Offset of the rendered block from the top of the sizer. */
  readonly offsetTop: number;
  /** False until the container has a measured height; see the note above. */
  readonly measured: boolean;
  /**
   * Re-read the container after scrolling it programmatically.
   *
   * A user scroll arrives as a `scroll` event and needs nothing. Assigning
   * `scrollTop` in code is different: the event is asynchronous at best, and
   * under jsdom it does not fire at all - so a caller that scrolls a row into
   * view and then looks for it would find the window unchanged. Making the
   * re-read explicit removes the dependency on event timing entirely.
   */
  readonly remeasure: () => void;
}

export interface UseVirtualRowsOptions {
  readonly count: number;
  readonly rowHeight: number;
  readonly overscan: number;
  /**
   * The scrolling element itself, not a ref to it.
   *
   * This started as a `RefObject` and that was a bug: a ref is not reactive, so
   * the effect below bound its listeners once and never re-ran when the node was
   * *replaced*. The list unmounts and remounts whenever it goes empty and back -
   * which is exactly what loading a project does - leaving the listeners on a
   * detached div and the window frozen at its initial size. Taking the element
   * through state means React re-runs the effect when the node changes, because
   * that is the one thing a ref cannot tell it.
   */
  readonly container: HTMLElement | null;
}

export function useVirtualRows({
  count,
  rowHeight,
  overscan,
  container,
}: UseVirtualRowsOptions): VirtualWindow {
  const [{ scrollTop, viewportHeight }, setMetrics] = useState({
    scrollTop: 0,
    viewportHeight: 0,
  });

  /*
    Scroll fires far faster than React can usefully re-render, so the read is
    coalesced onto a frame. The measurement itself is two property reads on an
    element the browser has already laid out - cheap - but the setState behind
    it is not, and a 120Hz trackpad would otherwise queue one render per event.
  */
  const frame = useRef<number | null>(null);
  const measure = useCallback((): void => {
    if (container === null || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setMetrics((current) =>
        current.scrollTop === container.scrollTop &&
        current.viewportHeight === container.clientHeight
          ? current
          : { scrollTop: container.scrollTop, viewportHeight: container.clientHeight }
      );
    });
  }, [container]);

  useEffect(() => {
    if (container === null) return;

    measure();
    container.addEventListener('scroll', measure, { passive: true });

    // The panel resizes with the window, with the rail collapsing at `lg`, and
    // with its own content - a ResizeObserver catches all three, where a window
    // resize listener would catch only the first.
    const observer = new ResizeObserver(measure);
    observer.observe(container);

    return () => {
      container.removeEventListener('scroll', measure);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [container, measure]);

  const totalHeight = count * rowHeight;

  if (viewportHeight === 0) {
    return { start: 0, end: count, totalHeight, offsetTop: 0, measured: false, remeasure: measure };
  }

  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);

  return {
    start,
    end,
    totalHeight,
    offsetTop: start * rowHeight,
    measured: true,
    remeasure: measure,
  };
}
