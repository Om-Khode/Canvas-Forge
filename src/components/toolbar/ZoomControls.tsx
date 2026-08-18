import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton, Tooltip } from '@/components/common';
import { elementsToPaint } from '@/features/elements/tree';
import { contentBounds } from '@/features/selection/bounds';
import { selectZoomPercent, useCanvasStore } from '@/store';

/**
 * Zoom readout, in/out, zoom-to-fit, and reset.
 *
 * Only the percentage subscribes to the store, and it subscribes to an integer
 * rather than to the viewport: `viewport` is a fresh object on every frame of a
 * pan, so a component watching it would re-render sixty times a second to
 * display a number that did not change. `selectZoomPercent` rounds first, so the
 * readout re-renders only when the digits actually differ.
 *
 * The three actions read `getState()` at click time instead of subscribing to
 * the document, the selection, or the viewport size they need. A button that
 * subscribes to the elements map to compute "zoom to fit" would re-render on
 * every pointermove of a drag, for a value it only ever reads once, on demand.
 */
export function ZoomControls() {
  const zoomPercent = useCanvasStore(selectZoomPercent);

  const zoomToFit = (): void => {
    const state = useCanvasStore.getState();
    // `elementsToPaint`, not `elementsInOrder`: `order` names root ids only, so
    // a root-level walk frames a group's cached box - which spans its hidden
    // members too - instead of the content that is actually on screen.
    const bounds = contentBounds(elementsToPaint(state.elements));
    // An empty document has no content to frame, so "fit" degrades to "reset"
    // rather than to a division by zero or a jump to the world origin.
    if (bounds === null) state.resetView(state.viewportSize);
    else state.zoomToFit(bounds, state.viewportSize);
  };

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
      <IconButton
        icon={ZoomOut}
        label="Zoom out"
        shortcut="mod+-"
        size="sm"
        onClick={() => {
          useCanvasStore.getState().zoomToStep('out');
        }}
      />

      <Tooltip label="Reset view" shortcut="mod+0" side="bottom" linkDescription={false}>
        <button
          type="button"
          aria-label={`Zoom ${zoomPercent} percent. Reset view.`}
          onClick={() => {
            const state = useCanvasStore.getState();
            state.resetView(state.viewportSize);
          }}
          // `tabular-nums` and a minimum width so the toolbar does not twitch
          // sideways as the percentage goes 100% → 95% → 100% during a pinch.
          className="text-ink-soft hover:bg-surface-2 hover:text-ink rounded-field h-7 min-w-14 px-1.5 text-xs font-medium tabular-nums transition-colors duration-120 ease-out"
        >
          {zoomPercent}%
        </button>
      </Tooltip>

      <IconButton
        icon={ZoomIn}
        label="Zoom in"
        shortcut="mod+="
        size="sm"
        onClick={() => {
          useCanvasStore.getState().zoomToStep('in');
        }}
      />

      <IconButton
        icon={Maximize}
        label="Zoom to fit"
        shortcut="shift+1"
        size="sm"
        onClick={zoomToFit}
      />
    </div>
  );
}
