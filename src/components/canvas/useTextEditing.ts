/**
 * The state behind the in-place text editor.
 *
 * A canvas cannot host a caret, so editing happens in a real `<textarea>`
 * positioned over the element. Everything hard about that is a question of
 * *agreement*: the DOM must lay the glyphs out exactly where the renderer will
 * paint them, or the caret drifts from the text under it.
 *
 * Two decisions buy that agreement:
 *
 *  1. **The overlay is scaled, not resized.** The textarea is sized in *world*
 *     units - `element.width` CSS pixels wide, `fontString(element)` for its
 *     font - and the whole box is then put through one `transform: scale(zoom)`.
 *     So the browser wraps the text against the same width, at the same font
 *     size, that `wrapText` will measure against in the renderer, and zoom can
 *     never introduce a rounding difference between the two. Scaling the font
 *     size by the zoom instead would wrap against a different metric at every
 *     zoom level.
 *  2. **Height comes from `measureTextBlock`** - the renderer's own layout
 *     function, through the drawers barrel. Not from `scrollHeight`, which is
 *     the DOM's opinion about a box the canvas will not draw.
 *
 * The document is the only draft buffer. The textarea's value *is*
 * `element.text`, written on every keystroke inside one open transaction, so
 * there is no second copy of the text to fall out of sync - and because a
 * transaction only pushes to history when it commits, the whole edit is one
 * undo entry no matter how much was typed (docs/architecture.md §6).
 */

import { useCallback, useEffect, useRef } from 'react';
import { fontString, measureTextBlock, type TextMeasurer } from '@/features/canvas/engine/drawers';
import { useCanvasStore, useElement, useViewport } from '@/store';
import type { ElementId, ScreenPoint, TextElement, Viewport } from '@/types';
import { worldPoint, worldToScreen } from '@/utils/coords';

/** History label for the whole edit, however many keystrokes it contains. */
const EDIT_LABEL = 'Edit text';

/* -------------------------------------------------------------- measuring -- */

/** A text measurer that also carries the canvas `font` shorthand. */
export type FontMeasurer = TextMeasurer & { font?: string };

let sharedMeasurer: FontMeasurer | null | undefined;

/**
 * A 2D context used only for `measureText`.
 *
 * Module-level and lazy: allocating a canvas per keystroke would be wasteful,
 * and allocating one at import time would run in environments that have no 2D
 * context at all. `undefined` means "not tried yet", `null` means "this
 * environment cannot measure text" - jsdom, where the honest answer is to leave
 * the height alone rather than invent metrics the renderer would disagree with.
 */
export function textMeasurer(): FontMeasurer | null {
  if (sharedMeasurer !== undefined) return sharedMeasurer;
  sharedMeasurer =
    typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  return sharedMeasurer;
}

/**
 * The height an `autoHeight` box should have for its current content.
 *
 * `null` when the element does not auto-size, when nothing can measure, or when
 * the height is already right - the caller uses that to skip a store write per
 * keystroke that would change nothing.
 */
export function autoHeightFor(
  element: TextElement,
  measurer: FontMeasurer | null
): number | null {
  if (!element.autoHeight || measurer === null) return null;
  // `ctx.font` has to be set before measuring, or every string comes back
  // measured against the context's default 10px sans-serif - the classic "why
  // is my canvas text the wrong size" bug, here as a wrong *wrap*.
  measurer.font = fontString(element);

  const { height } = measureTextBlock(measurer, element);
  // Never below one line, so an emptied box does not collapse to a zero-height
  // element the user can no longer see or grab.
  const next = Math.max(height, element.fontSize * element.lineHeight);
  return Math.abs(next - element.height) < HEIGHT_EPSILON ? null : next;
}

/** Sub-half-pixel height changes are invisible and not worth a store write. */
const HEIGHT_EPSILON = 0.5;

/* --------------------------------------------------------------- geometry -- */

export interface TextEditorBox {
  /** Canvas-relative screen position of the element's unrotated top-left corner. */
  readonly screen: ScreenPoint;
  readonly zoom: number;
  /** World-space size. The overlay is laid out at this size and then scaled. */
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export function textEditorBox(element: TextElement, viewport: Viewport): TextEditorBox {
  return {
    screen: worldToScreen(worldPoint(element.x, element.y), viewport),
    zoom: viewport.zoom,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
  };
}

/* ---------------------------------------------------------------- session -- */

export interface TextEditSession {
  readonly element: TextElement;
  readonly box: TextEditorBox;
  /** Writes the text (and the auto-height) into the open transaction. */
  readonly setText: (text: string) => void;
  /** Commit, delete-if-empty, or roll back if nothing was typed. Idempotent. */
  readonly finish: () => void;
}

/**
 * Opens an edit on `elementId` and keeps it in step with the store.
 *
 * Returns `null` when the id does not name a text element - an element deleted
 * from under the editor, or an interaction state that outlived its target.
 */
export function useTextEditing(elementId: ElementId): TextEditSession | null {
  const element = useElement(elementId);
  const viewport = useViewport();
  const text = element?.type === 'text' ? element.text : '';

  /*
   * The gate that makes `finish` idempotent. It is reached from four places -
   * blur, Escape, the machine ending the edit, and unmount - and every one of
   * them can happen after another has already closed the transaction.
   */
  const closed = useRef(false);
  /** The text as it was when the edit opened, to tell "no change" from "edited". */
  const initialText = useRef(text);

  const finish = useCallback((): void => {
    if (closed.current) return;
    closed.current = true;

    const store = useCanvasStore.getState();
    const current = store.elements.byId[elementId];
    const edited = current?.type === 'text' ? current : null;

    // The element vanished mid-edit. Committed rather than aborted: whatever
    // removed it did so *inside* this transaction (an open transaction nests
    // everything), so rolling back would resurrect an element the user asked to
    // delete. Committing keeps reality and closes the transaction, which is the
    // part that actually matters - an open one blocks autosave and refuses undo.
    if (edited === null) {
      store.commitTransaction();
      endEditing();
      return;
    }

    // Restore the visibility the edit borrowed *before* deciding what to do
    // with the transaction, so whichever branch runs leaves a paintable element.
    if (!edited.visible) store.updateElement(elementId, { visible: true }, EDIT_LABEL);

    if (edited.text.length === 0) {
      // An empty text element is invisible and unfindable on the canvas. Roll
      // the edit back first so the deletion is a clean single step from the
      // pre-edit document rather than a delete stacked on an edit.
      store.abortTransaction();
      store.removeElements([elementId]);
    } else if (edited.text === initialText.current) {
      // Nothing was typed. Aborting restores the opening snapshot exactly -
      // including the visibility flag and the redo stack - where committing
      // would push an entry whose two sides are indistinguishable.
      store.abortTransaction();
    } else {
      store.commitTransaction();
    }

    endEditing();
  }, [elementId]);

  /*
   * Opening and closing the transaction is deliberately tied to the *mount*,
   * not to any handler: however the editor goes away - commit, Escape, the
   * element being deleted, the component being unmounted by a state change it
   * never saw - exactly one transaction was opened and exactly one is closed.
   */
  useEffect(() => {
    const store = useCanvasStore.getState();
    const opened = store.elements.byId[elementId];
    // Re-armed rather than only initialised: StrictMode mounts an effect,
    // tears it down, and mounts it again with the *same* refs, so a session
    // that inherited `closed = true` from the discarded mount would never
    // commit anything the user typed in the real one.
    closed.current = false;
    initialText.current = opened?.type === 'text' ? opened.text : '';

    store.beginTransaction(EDIT_LABEL);
    // Hide the canvas copy so the glyphs are not painted twice, a hair apart,
    // by two different layout engines. This is a document mutation, but it is
    // made *inside* the transaction and undone before it commits, so history
    // never sees it: history only records the difference between the opening
    // snapshot and the state at commit.
    store.updateElement(elementId, { visible: false }, EDIT_LABEL);

    return finish;
  }, [elementId, finish]);

  /*
   * A window that loses focus ends the edit.
   *
   * Not only good behaviour (every editor commits when you alt-tab away) but
   * load-bearing: `visible: false` is live document state while the edit is
   * open, and autosave flushes unconditionally on `visibilitychange`. Blur
   * arrives before that flush, so the hidden flag is never what gets persisted.
   */
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('blur', finish);
    };
  }, [finish]);

  const setText = useCallback(
    (next: string): void => {
      const store = useCanvasStore.getState();
      const current = store.elements.byId[elementId];
      if (current?.type !== 'text') return;

      const height = autoHeightFor({ ...current, text: next }, textMeasurer());
      store.updateElement(
        elementId,
        height === null ? { text: next } : { text: next, height },
        EDIT_LABEL
      );
    },
    [elementId]
  );

  if (element?.type !== 'text') return null;
  return { element, box: textEditorBox(element, viewport), setText, finish };
}

/**
 * Leaves the `editing-text` interaction state.
 *
 * The pointer machine emits `endTextEdit` when a press ends the edit, but the
 * overlay can also close itself (Escape, blur) - in which case the store has to
 * be told, or it would keep reporting an edit that no longer has a caret.
 */
function endEditing(): void {
  const store = useCanvasStore.getState();
  if (store.interaction.kind === 'editing-text') store.setInteraction({ kind: 'idle' });
  // The text tool has done its job once the box has content; leaving it armed
  // means the next click on the canvas starts another empty text box, which
  // every user reads as the editor having ignored them.
  if (store.tool === 'text') store.setTool('select');
}
