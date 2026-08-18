/**
 * Drag-and-drop and paste of image files onto the canvas.
 *
 * Everything document-shaped lives in `ingest.ts`; this hook is the DOM half -
 * which events to listen to, when the canvas should look like a drop target,
 * and where in world space the file landed.
 *
 * Three details are less obvious than they look:
 *
 *  1. **`dragover` must call `preventDefault`.** The browser's default action
 *     for a dragged file is "navigate to it", and without the cancel the drop
 *     event never fires - the page just replaces itself with the image.
 *  2. **Enter/leave are counted, not toggled.** `dragleave` fires every time the
 *     pointer crosses into a *child* element, so a boolean flag flickers off the
 *     moment the drag passes over anything nested inside the drop zone.
 *  3. **The paste listener is registered in the capture phase.** `useCommands`
 *     has a bubble-phase `paste` listener that falls back to the internal
 *     element clipboard for anything it does not recognise, so an image paste
 *     would *also* re-paste whatever was last copied. Capturing runs first and
 *     `stopPropagation` keeps the two from firing on one keystroke.
 *
 * Nothing here subscribes to the store: the viewport and the document are read
 * imperatively inside handlers. Subscribing would re-render the canvas host on
 * every pan, which is precisely the cost the architecture exists to avoid.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent as ReactDragEvent, RefObject } from 'react';
import {
  clearImageError,
  getImageError,
  imageFilesOf,
  insertImageFiles,
  pickImageFiles,
  reportImageError,
  subscribeImageError,
  viewportCenterWorldPoint,
} from '@/features/images/ingest';
import { isTypingTarget } from '@/features/shortcuts/registry';
import { useCanvasStore } from '@/store';
import type { WorldPoint } from '@/types';
import { eventToScreenPoint, screenToWorld } from '@/utils/coords';

/** What a `DataTransfer` says it is carrying. Files are the only kind we claim. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  // `types` rather than `files`: during dragover the file list is deliberately
  // empty for privacy, and only the type list is readable. A drag of selected
  // text reports 'text/plain' and must not light the canvas up.
  return transfer !== null && [...transfer.types].includes('Files');
}

export interface ImageDropHandlers {
  readonly onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDrop: (event: ReactDragEvent<HTMLElement>) => void;
}

export interface ImageDrop {
  /** True while files are being dragged over the canvas. Drives the drop-zone chrome. */
  readonly isDropTarget: boolean;
  /** The last ingest failure, in words the user can act on. `null` when there is none. */
  readonly error: string | null;
  readonly dismissError: () => void;
  /** Opens the system picker and adds the chosen images at the viewport centre. */
  readonly openPicker: () => void;
  readonly dropHandlers: ImageDropHandlers;
}

export function useImageDrop(canvasRef: RefObject<HTMLCanvasElement | null>): ImageDrop {
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Counted rather than a boolean - see the header note on nested dragleave.
  const dragDepth = useRef(0);

  const error = useSyncExternalStore(subscribeImageError, getImageError, getImageError);

  /** Canvas-relative screen point → world point, through `utils/coords` only. */
  const worldPointOf = useCallback(
    (event: { clientX: number; clientY: number }): WorldPoint => {
      const canvas = canvasRef.current;
      if (canvas === null) return viewportCenterWorldPoint();
      const screen = eventToScreenPoint(event, canvas.getBoundingClientRect());
      return screenToWorld(screen, useCanvasStore.getState().viewport);
    },
    [canvasRef]
  );

  const endDrag = useCallback((): void => {
    dragDepth.current = 0;
    setIsDropTarget(false);
  }, []);

  const dropHandlers = useMemo<ImageDropHandlers>(
    () => ({
      onDragEnter: (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        dragDepth.current += 1;
        setIsDropTarget(true);
      },
      onDragOver: (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        // Says "this will add a copy" rather than "this will move the file".
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) endDrag();
      },
      onDrop: (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        endDrag();

        const files = imageFilesOf(event.dataTransfer.files);
        if (files.length === 0) {
          // The drop was files, but none of them were images we can store.
          // Silence here would look like the editor had simply ignored it.
          reportImageError('That file is not a supported image (PNG, JPEG, GIF, WebP, or SVG).');
          return;
        }
        void insertImageFiles(files, worldPointOf(event));
      },
    }),
    [endDrag, worldPointOf]
  );

  /* ------------------------------------------------------------- pasting -- */

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const data = event.clipboardData;
      if (data === null) return;
      // A paste into the text editor, a layer-rename field, or a dialog is not
      // a canvas paste.
      if (isTypingTarget(event.target)) return;
      if (useCanvasStore.getState().activeDialog !== null) return;

      const files = imageFilesOf(data.files);
      if (files.length === 0) return;

      event.preventDefault();
      // Keeps `useCommands`' bubble-phase handler from pasting the element
      // clipboard on top of the image.
      event.stopPropagation();
      // A paste has no pointer position, so it lands where the user is looking.
      void insertImageFiles(files, viewportCenterWorldPoint());
    };

    document.addEventListener('paste', onPaste, true);
    return () => {
      document.removeEventListener('paste', onPaste, true);
    };
  }, []);

  /* -------------------------------------------------------------- picker -- */

  const openPicker = useCallback((): void => {
    void pickImageFiles().then((files) => {
      if (files.length === 0) return;
      return insertImageFiles(files, viewportCenterWorldPoint());
    });
  }, []);

  return {
    isDropTarget,
    error,
    dismissError: clearImageError,
    openPicker,
    dropHandlers,
  };
}
