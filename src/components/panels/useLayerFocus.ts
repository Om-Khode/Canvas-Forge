/**
 * Focusing a row that may not be in the DOM.
 *
 * Roving focus over a full list is a `querySelector` and a `.focus()`. Over a
 * *windowed* list it is not: the row the keyboard is moving to may be outside
 * the rendered range, in which case there is nothing to focus yet. So the order
 * is inverted - scroll first, which brings the row into the window, then focus
 * on the render that follows. Arrow-key navigation off the bottom of the
 * viewport takes this path every time, so it is the normal case rather than an
 * edge one.
 *
 * Extracted from `LayersPanel` because it is the one part of that component
 * that is about the DOM rather than about layers: it needs the scroll container
 * and the window's `remeasure`, and nothing else.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { LAYER_LIST_PADDING, LAYER_ROW_HEIGHT } from '@/constants';

export interface LayerFocus {
  /** Brings a row into view without touching focus. Returns true if it scrolled. */
  readonly scrollIndexIntoView: (index: number) => boolean;
  /** Scrolls `index` into view and focuses it, deferring if it is not rendered yet. */
  readonly focusRow: (index: number) => void;
  /**
   * As `focusRow`, and again after the next render.
   *
   * For a move that changes *which element* is at an index - a reorder. The
   * node at that index already exists, so `focusRow` alone would focus the row
   * about to be replaced and leave focus on the wrong layer.
   */
  readonly focusRowAfterRender: (index: number) => void;
}

export function useLayerFocus(
  listRef: RefObject<HTMLElement | null>,
  remeasure: () => void
): LayerFocus {
  /** A row to focus once it has been rendered. */
  const pending = useRef<number | null>(null);

  const scrollIndexIntoView = useCallback(
    (index: number): boolean => {
      const container = listRef.current;
      if (container === null) return false;

      const top = index * LAYER_ROW_HEIGHT;
      const bottom = top + LAYER_ROW_HEIGHT + LAYER_LIST_PADDING * 2;
      const before = container.scrollTop;

      if (top < before) container.scrollTop = top;
      else if (bottom > before + container.clientHeight) {
        container.scrollTop = bottom - container.clientHeight;
      }
      if (container.scrollTop === before) return false;

      // Assigning scrollTop does not synchronously produce a scroll event, so
      // the window is told directly rather than waiting for one to arrive.
      remeasure();
      return true;
    },
    [listRef, remeasure]
  );

  const focusRow = useCallback(
    (index: number): void => {
      scrollIndexIntoView(index);
      const row = listRef.current?.querySelector<HTMLElement>(`[data-layer-index="${index}"]`);
      if (row) row.focus();
      else pending.current = index;
    },
    [listRef, scrollIndexIntoView]
  );

  const focusRowAfterRender = useCallback(
    (index: number): void => {
      pending.current = index;
      focusRow(index);
    },
    [focusRow]
  );

  useEffect(() => {
    const index = pending.current;
    if (index === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-layer-index="${index}"]`);
    if (!row) return;
    pending.current = null;
    row.focus();
  });

  return { scrollIndexIntoView, focusRow, focusRowAfterRender };
}
