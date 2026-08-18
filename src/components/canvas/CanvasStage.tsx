import { useRef } from 'react';
import { usePointerInteraction } from '@/features/canvas/interaction/usePointerInteraction';
import { useImageDrop } from '@/features/images';
import { cn } from '@/utils/cn';
import { TextEditorOverlay } from './TextEditorOverlay';
import { useCanvasSize } from './useCanvasSize';
import { useRenderer } from './useRenderer';

/**
 * The `<canvas>` host and the DOM chrome that has to sit on top of it.
 *
 * The canvas itself renders **once** and then stays put. It has no children, no
 * store selectors, and no state that a document change can touch - element edits
 * reach the pixels through `useRenderer`'s imperative subscription, never through
 * the reconciler. `CanvasStage.test` asserts that, because it is the kind of
 * property that is easy to state and easy to lose to one innocent-looking
 * `useStore(...)` six months later.
 *
 * Three things here are DOM rather than pixels, and each is here for a reason
 * the canvas cannot solve:
 *
 *  - **`TextEditorOverlay`** - a canvas cannot host a caret. It subscribes to
 *    one field (`interaction`) and renders nothing until an edit opens, so the
 *    re-render discipline above survives it.
 *  - **The drop zone** - files are dropped on DOM nodes, not on pixels.
 *  - **A keyboard route to the file picker** - the image tool is otherwise only
 *    reachable by pressing a tool and then clicking the canvas, which a
 *    keyboard-only user cannot do.
 *
 * Two attributes on the canvas are load-bearing rather than decorative:
 *
 *  - `touch-action: none` - without it the browser claims the gesture for
 *    scroll/pinch and pointermove stops arriving mid-drag on every touch device.
 *  - `tabIndex` - a canvas is not focusable by default, and the editor needs
 *    keyboard focus to land somewhere that isn't a toolbar button.
 */

const DESCRIPTION_ID = 'canvas-stage-description';

export interface CanvasStageProps {
  readonly className?: string;
}

export function CanvasStage({ className }: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const size = useCanvasSize(containerRef);
  useRenderer(canvasRef, size);
  const handlers = usePointerInteraction(canvasRef);
  const images = useImageDrop(canvasRef);

  return (
    <div
      ref={containerRef}
      // `select-none`: a drag that starts on the canvas must not sweep a text
      // selection across the description below it or the toolbar above it.
      className={cn('bg-canvas relative h-full w-full overflow-hidden select-none', className)}
      {...images.dropHandlers}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        tabIndex={0}
        aria-label="Design canvas"
        aria-describedby={DESCRIPTION_ID}
        {...handlers}
      />

      <TextEditorOverlay />

      {images.isDropTarget && (
        <div
          // `pointer-events-none`: the panel must not become the drop target
          // itself, or the `dragleave` that fires as the pointer enters it
          // would cancel the very drop it is advertising.
          className="border-accent bg-accent-subtle/40 pointer-events-none absolute inset-3 flex items-center justify-center rounded-panel border-2 border-dashed"
          role="status"
        >
          <p className="bg-surface-1 text-ink shadow-panel rounded-control px-3 py-1.5 text-sm font-medium">
            Drop images to add them to the canvas
          </p>
        </div>
      )}

      {images.error !== null && (
        <div
          // `alert` rather than `status`: this is the outcome of something the
          // user just did, and it explains why nothing appeared.
          role="alert"
          className="bg-surface-1 text-ink shadow-panel rounded-control absolute bottom-3 left-1/2 flex max-w-md -translate-x-1/2 items-start gap-3 px-3 py-2 text-sm"
        >
          <span className="text-danger">{images.error}</span>
          <button
            type="button"
            className="text-ink-muted hover:text-ink shrink-0 underline"
            onClick={images.dismissError}
          >
            Dismiss
          </button>
        </div>
      )}

      {/*
        Off-screen but focusable, so the image tool has a keyboard route. The
        picker is a detached `<input type="file">` clicked programmatically -
        the only cross-browser way to open a file dialog - which means the
        button, not the input, is what has to be reachable.
      */}
      <button
        type="button"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-10 focus:rounded-control focus:bg-surface-1 focus:px-3 focus:py-1.5 focus:text-sm focus:shadow-panel"
        onClick={images.openPicker}
      >
        Add an image to the canvas
      </button>

      {/*
        Canvas pixels are not readable by a screen reader and no amount of ARIA
        changes that. Rather than paper over it, the description points at the
        thing that *is* readable: the layers panel is the document's DOM
        counterpart (docs/architecture.md §12).
      */}
      <p id={DESCRIPTION_ID} className="sr-only">
        An infinite drawing surface. Canvas contents cannot be read by assistive technology; the
        layers panel lists every element on the canvas and lets you select, rename, hide, and lock
        each one. Drag to draw or select, hold space to pan, and use the zoom controls in the
        toolbar. Images can be dropped or pasted onto the canvas.
      </p>
    </div>
  );
}
