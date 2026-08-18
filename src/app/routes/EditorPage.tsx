import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { CanvasStage } from '@/components/canvas';
import { CommandPalette, ExportDialog, ProjectDialog } from '@/components/dialogs';
import { LayersPanel, Minimap, PanelSheet, PropertiesPanel } from '@/components/panels';
import { Toolbar } from '@/components/toolbar';
import { useCommands } from '@/features/commands';
import { createStressDocument, parseStressCount, STRESS_PARAM } from '@/features/perf';
import { projectSession, useProjectSession } from '@/features/project/useProjectSession';
import { elementsToPaint } from '@/features/elements/tree';
import { contentBounds } from '@/features/selection/bounds';
import { useCanvasStore } from '@/store';

/**
 * The editor shell: toolbar across the top, canvas filling the rest, panels
 * docked on the right - or overlaid, depending on how much room there is.
 *
 * Structural decisions worth naming:
 *
 *  - **The canvas is the flex child that shrinks, not the panels.** `min-w-0`
 *    and `min-h-0` on the middle row are what make that true; without them a
 *    flex item refuses to go below its content size and the canvas pushes the
 *    panels off screen instead of giving up space.
 *  - **Each region has its own ErrorBoundary.** A malformed element that crashes
 *    the properties panel's render must not take the canvas - and the user's
 *    unsaved work - down with it. Boundaries per region, not one at the root.
 *  - **The breakpoint is a JS decision, not two CSS visibilities.** Rendering
 *    the rail and the sheet together and hiding one with `lg:hidden` would mount
 *    every panel twice: two elements with the same accessible name, two
 *    subscriptions, and a focus trap wrapping a copy of the tree the user can
 *    see. One `matchMedia` read picks a presentation and only that one exists.
 */

/** Tailwind's `lg`. The width below which a rail and a canvas no longer both fit. */
const DESKTOP_QUERY = '(min-width: 64rem)';

export function EditorPage() {
  const [searchParams] = useSearchParams();
  const wantsDemo = searchParams.get('demo') === '1';
  const stressCount = parseStressCount(searchParams.get(STRESS_PARAM));

  // Both are reference-counted internally, so StrictMode's double mount installs
  // one keydown listener and restores one document.
  useCommands();
  const session = useProjectSession();

  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const propertiesVisible = useCanvasStore((state) => state.panels.properties);
  const layersVisible = useCanvasStore((state) => state.panels.layers);
  const anyPanelVisible = propertiesVisible || layersVisible;

  const closePanels = useCallback((): void => {
    const { setPanelVisible } = useCanvasStore.getState();
    setPanelVisible('properties', false);
    setPanelVisible('layers', false);
  }, []);

  /*
   * Panel visibility defaults to on, which is right on a desktop rail and wrong
   * as a modal sheet: a tablet visitor would arrive to find the editor already
   * covered by a panel they never asked for, with the canvas unreachable until
   * they dismissed it.
   *
   * So entering compact closes the panels, and leaving it restores whatever the
   * user had. The flags stay a desktop preference that a narrow viewport
   * borrows, rather than two different meanings sharing one pair of booleans.
   */
  const desktopPanels = useRef<{ properties: boolean; layers: boolean } | null>(null);
  useEffect(() => {
    if (!isDesktop) {
      desktopPanels.current = { properties: propertiesVisible, layers: layersVisible };
      closePanels();
      return;
    }
    const remembered = desktopPanels.current;
    if (remembered === null) return;
    desktopPanels.current = null;
    const { setPanelVisible } = useCanvasStore.getState();
    setPanelVisible('properties', remembered.properties);
    setPanelVisible('layers', remembered.layers);
    // Deliberately keyed on the breakpoint alone: including the visibility flags
    // would re-run this on every toggle and immediately undo the user's click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);

  useEffect(() => {
    // `/editor?demo=1` from the landing page. Waited on `status` rather than
    // fired on mount: the session restores the last project asynchronously, and
    // opening the demo first would be overwritten the moment that finished.
    if (!wantsDemo || session.status === 'loading') return;
    void projectSession.openDemo();
    // Runs once per arrival at the demo link; re-opening it on every status
    // change would discard edits the visitor made to the demo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsDemo, session.status === 'loading']);

  useEffect(() => {
    // `/editor?stress=2000` - the benchmark document (docs/performance.md).
    // Dev-only: it is an instrument, not a feature, and shipping a URL that can
    // replace the user's document with 2,000 generated shapes is a footgun.
    if (!import.meta.env.DEV || stressCount === null || session.status === 'loading') return;
    void loadStressDocument(stressCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stressCount, session.status === 'loading']);

  const panels = (
    <>
      {propertiesVisible && (
        <ErrorBoundary label="the properties panel">
          <PropertiesPanel className="min-h-0" />
        </ErrorBoundary>
      )}
      {layersVisible && (
        <ErrorBoundary label="the layers panel">
          <LayersPanel className="min-h-0" />
        </ErrorBoundary>
      )}
    </>
  );

  /*
    The rail divides its height between the two panels rather than letting them
    size to their contents.

    Previously the properties panel was capped with `max-h`, so it grew and
    shrank with the selection - an empty state is a short card, a text element a
    tall one - and the layers panel below it jumped by ~280px every time the
    selection changed. A control that moves when you select something is hard to
    aim at and reads as instability.

    Fixed `fr` tracks rather than percentages: a percentage height has to resolve
    against a definite parent height, and against a stretched flex item it
    quietly falls back to sizing on content - which is exactly the failure this
    replaced, and it *looks* applied in the class list while doing nothing.
    `minmax(0, …)` lets each track shrink below its content so the panels scroll
    internally instead of overflowing the rail.
  */
  const railRows =
    propertiesVisible && layersVisible
      ? 'grid-rows-[minmax(0,11fr)_minmax(0,9fr)]'
      : 'grid-rows-[minmax(0,1fr)]';

  return (
    <div className="bg-surface-0 flex h-dvh flex-col overflow-hidden">
      <Toolbar />

      <div className="flex min-h-0 flex-1">
        <ErrorBoundary label="the canvas">
          {/* `relative` so the minimap can float over the canvas rather than
              taking layout space away from it. */}
          <main className="relative min-h-0 min-w-0 flex-1">
            <CanvasStage />
            {isDesktop && (
              <ErrorBoundary label="the minimap">
                <Minimap className="absolute right-3 bottom-3 z-10" />
              </ErrorBoundary>
            )}
          </main>
        </ErrorBoundary>

        {isDesktop && anyPanelVisible && (
          // 17rem = the panels' own 16rem width plus the rail's padding. The
          // panels bring their own frame, so the rail is spacing and nothing
          // else - a border here would draw a second edge beside their first.
          <div className={`grid w-68 shrink-0 gap-2 p-2 ${railRows}`}>{panels}</div>
        )}
      </div>

      {/* Below `lg` the same panels arrive as a dismissible overlay, so the
          canvas keeps its full width instead of being squeezed into a strip. */}
      {!isDesktop && (
        <PanelSheet open={anyPanelVisible} onClose={closePanels} title="Panels">
          {panels}
        </PanelSheet>
      )}

      {/* All three read `activeDialog` and close themselves, so the shell never
          holds "which dialog is open" in component state. Boundaried together:
          at most one is ever visible. */}
      <ErrorBoundary label="a dialog">
        <CommandPalette />
        <ExportDialog />
        <ProjectDialog />
      </ErrorBoundary>
    </div>
  );
}

/**
 * A media query as an external store.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the match is an
 * external mutable value, and reading it during render is exactly what this
 * hook exists to make safe. The alternative renders one frame at the wrong
 * breakpoint before the effect corrects it - which, here, would mount the panel
 * rail and then immediately tear it down on every load at tablet width.
 *
 * Not exported: which breakpoint the editor changes shape at is the shell's own
 * decision, and a second caller would be a second opinion about it.
 */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    [query]
  );

  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/**
 * Applies the generated benchmark document.
 *
 * It lands in a *fresh* project rather than in the one that is open: autosave
 * writes whatever is in the store to the current project, so replacing the
 * document in place would persist 2,000 generated shapes over the user's real
 * work. A benchmark that destroys data is not a benchmark.
 */
async function loadStressDocument(count: number): Promise<void> {
  // The fit below needs a measured canvas, so wait for one.
  //
  // This also used to be load-bearing for a different reason: `frameWhenLaidOut`
  // armed a store subscription whose own `zoomToFit` write re-entered it, and a
  // stress load reproduced the resulting stack overflow every time. That bug is
  // fixed at its source now (problems-log 003), so this wait is back to being
  // what it looks like - waiting for a size.
  await whenCanvasMeasured();

  await projectSession.newProject(`Stress test - ${count} elements`);

  const document = createStressDocument({ count });
  useCanvasStore.getState().replaceDocument(document);

  const state = useCanvasStore.getState();
  // Read back from the store rather than from `document`: `replaceDocument`
  // applies the group invariants, so this is the same tree the canvas will
  // paint. `elementsToPaint` for the reason every other fit uses it - `order`
  // names root ids only.
  const bounds = contentBounds(elementsToPaint(state.elements));
  if (bounds !== null && state.viewportSize.width > 0) {
    state.zoomToFit(bounds, state.viewportSize);
  }
}

/** Resolves once the canvas component has published a non-zero size. */
function whenCanvasMeasured(): Promise<void> {
  if (useCanvasStore.getState().viewportSize.width > 0) return Promise.resolve();

  return new Promise((resolve) => {
    const unsubscribe = useCanvasStore.subscribe((state) => {
      if (state.viewportSize.width === 0) return;
      // Unsubscribed *before* resolving, which is precisely the ordering the
      // session's version gets wrong.
      unsubscribe();
      resolve();
    });
  });
}
