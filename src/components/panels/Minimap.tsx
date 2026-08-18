import { useRef } from 'react';
import { Maximize, X } from 'lucide-react';

import { IconButton, Panel } from '@/components/common';
import { useTheme } from '@/hooks/useTheme';
import { elementsToPaint } from '@/features/elements/tree';
import { contentBounds } from '@/features/selection/bounds';
import { useCanvasStore, usePanelVisible } from '@/store';
import { cn } from '@/utils/cn';
import { MINIMAP_HEIGHT_PX, MINIMAP_WIDTH_PX, useMinimapNavigation } from './useMinimapNavigation';

export interface MinimapProps {
  className?: string;
}

/**
 * A thumbnail of the whole document with the current viewport drawn on it.
 *
 * The drawing, the invalidation policy and the drag maths live in
 * `useMinimapNavigation` - this file is the frame around them. What is worth
 * noticing here is what the component *doesn't* subscribe to: only
 * `panels.minimap` and the theme, neither of which changes during a pan. The
 * document and the viewport rectangle are painted by an imperative store
 * subscription into two stacked canvases, so a pan costs this component zero
 * renders and the reconciler zero work - the same discipline the canvas stage
 * follows.
 *
 * **Accessibility.** The map is `aria-hidden`: it is a pixel rendering of
 * content a screen reader cannot read, and the layers panel is the document's
 * real accessible counterpart (docs/architecture.md §12). Marking it decorative
 * is honest; adding an ARIA label to a canvas would only make it *sound*
 * available. The panel's own controls are ordinary buttons and stay in the tab
 * order, and every navigation the map offers by pointer is available from the
 * keyboard through the zoom commands.
 */
export function Minimap({ className }: MinimapProps) {
  const visible = usePanelVisible('minimap');
  // Mounting is the gate rather than a `hidden` class: an invisible minimap must
  // not hold a live Renderer redrawing the document behind the user's back.
  if (!visible) return null;
  return <MinimapPanel {...(className === undefined ? {} : { className })} />;
}

function MinimapPanel({ className }: MinimapProps) {
  // The refs are owned here and handed to the hook, matching `useRenderer` and
  // `usePointerInteraction`: a hook that returns refs makes every consumer read
  // one during render, which React's rules of refs (rightly) forbid.
  const documentCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Subscribing to the theme here is what repaints the overlay's tokens when it
  // flips; a canvas does not re-style itself the way a `<div>` does.
  const { theme } = useTheme();
  const handlers = useMinimapNavigation(documentCanvasRef, overlayCanvasRef, surfaceRef, theme);

  return (
    <Panel
      as="section"
      title="Minimap"
      scroll={false}
      className={cn('overflow-hidden', className)}
      actions={
        <>
          <IconButton
            icon={Maximize}
            label="Zoom to fit"
            shortcut="mod+1"
            size="sm"
            tooltipSide="left"
            onClick={zoomToFit}
          />
          <IconButton
            icon={X}
            label="Hide minimap"
            size="sm"
            tooltipSide="left"
            onClick={() => {
              useCanvasStore.getState().setPanelVisible('minimap', false);
            }}
          />
        </>
      }
    >
      <div
        ref={surfaceRef}
        aria-hidden="true"
        className="bg-canvas relative cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        style={{ width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX }}
        {...handlers}
      >
        {/* Two stacked surfaces, because they change at completely different
            rates: the document below (rate-limited, N elements) and the viewport
            rectangle above (per frame, three draw calls). Splitting them is what
            lets a pan avoid repainting the document at all.

            The `data-testid`s are the one place this project uses them: both
            canvases are deliberately `aria-hidden`, so there is no accessible
            query that can tell them apart, and "which surface repainted" is
            exactly what the invalidation tests assert. */}
        <canvas
          ref={documentCanvasRef}
          data-testid="minimap-document"
          className="block"
          style={{ width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX }}
        />
        <canvas
          ref={overlayCanvasRef}
          data-testid="minimap-viewport"
          className="pointer-events-none absolute top-0 left-0 block"
          style={{ width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX }}
        />
      </div>
    </Panel>
  );
}

/**
 * The same operation the toolbar's fit button performs, written out rather than
 * dispatched through the command registry: a panel whose button silently does
 * nothing when the command layer happens not to be mounted is a worse dependency
 * than four lines of store calls that are correct on their own.
 */
function zoomToFit(): void {
  const state = useCanvasStore.getState();
  // `elementsToPaint`, not `elementsInOrder`: `order` names root ids only, and
  // the frame has to be around what paints, not around a group's cached box.
  const bounds = contentBounds(elementsToPaint(state.elements));
  if (bounds === null) state.resetView(state.viewportSize);
  else state.zoomToFit(bounds, state.viewportSize);
}
