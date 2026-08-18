import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayersPanel } from './LayersPanel';
import { Minimap } from './Minimap';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from '@/components/toolbar';
import { createRectangle } from '@/features/elements/factory';
import { createStressElements } from '@/features/perf';
import { resetCanvasStore, useCanvasStore } from '@/store';
import { viewportToFit, worldRect } from '@/utils/coords';
import { MINIMAP_HEIGHT_PX, MINIMAP_WIDTH_PX } from './useMinimapNavigation';

/**
 * The minimap's whole reason to be careful is that it draws the *entire*
 * document, so anything that invalidates it on a per-frame signal turns a
 * navigation aid into a frame-rate tax. These tests pin the invalidation policy
 * described in `useMinimapNavigation`:
 *
 *   document changed → repaint (rate-limited)
 *   viewport changed → move a `<div>`, repaint nothing, render no React
 */

/**
 * jsdom has no 2D context; the proxy records what was asked of it, counted per
 * canvas. Which of the two surfaces repainted is the entire subject of the
 * invalidation tests, so one shared counter would answer the wrong question.
 */
function stubCanvasContext(): {
  paints: (surface: string) => number;
  shapeFills: (surface: string) => number;
} {
  const paints = new Map<string, number>();
  // `fill()` is the path fill every shape drawer ends on, and nothing in the
  // chrome uses it (the backdrop is a `fillRect`). So it counts *content*, which
  // is what makes "the document is on the map" observable through a stub.
  const fills = new Map<string, number>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    const surface = this.dataset['testid'] ?? 'unknown';
    const assigned: Record<string, unknown> = { globalAlpha: 1 };
    return new Proxy(assigned, {
      get: (target, property) => {
        if (property in target) return target[property as string];
        // One `clearRect` per pass over a surface - the cheapest honest proxy
        // for "this canvas repainted".
        if (property === 'clearRect') {
          return () => {
            paints.set(surface, (paints.get(surface) ?? 0) + 1);
          };
        }
        if (property === 'fill') {
          return () => {
            fills.set(surface, (fills.get(surface) ?? 0) + 1);
          };
        }
        if (property === 'measureText') return () => ({ width: 0 });
        return () => undefined;
      },
      set: (target, property, value: unknown) => {
        target[property as string] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  });
  return {
    paints: (surface) => paints.get(surface) ?? 0,
    shapeFills: (surface) => fills.get(surface) ?? 0,
  };
}

const DOCUMENT_SURFACE = 'minimap-document';
const OVERLAY_SURFACE = 'minimap-viewport';

/** rAF under test control, so "a repaint was requested" is observable. */
function stubAnimationFrame(): { flush: () => void; restore: () => void } {
  const realRequest = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  let queue: FrameRequestCallback[] = [];

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });

  return {
    restore: () => {
      vi.stubGlobal('requestAnimationFrame', realRequest);
      vi.stubGlobal('cancelAnimationFrame', realCancel);
    },
    flush: () => {
      const due = queue;
      queue = [];
      for (const callback of due) callback(0);
    },
  };
}

const state = () => useCanvasStore.getState();

function seedDocument(count = 40): void {
  const elements = createStressElements({ count, seed: 3 });
  state().addElements(elements);
  state().setViewportSize(1200, 800);
}

function showMinimap(): void {
  state().setPanelVisible('minimap', true);
}

/** The map surface is the pointer target; it is `aria-hidden`, so query by role is out. */
function mapSurface(): HTMLElement {
  const surface = screen.getByTestId(OVERLAY_SURFACE).parentElement;
  if (surface === null) throw new Error('minimap surface missing');
  return surface;
}

/**
 * jsdom gives every element a zero-sized rect, which would make every pointer
 * position map to the same world point. The surface is pinned at a known
 * offset so the coordinate maths under test is the component's, not jsdom's.
 */
function stubSurfaceRect(): void {
  // jsdom implements none of the Pointer Capture API. The component uses it for
  // the same reason the canvas does - a drag that leaves a 192×128 box must keep
  // steering - so the gap is stubbed rather than designed around.
  const captured = new Set<number>();
  Object.assign(HTMLElement.prototype, {
    setPointerCapture(this: HTMLElement, id: number) {
      captured.add(id);
    },
    releasePointerCapture(this: HTMLElement, id: number) {
      captured.delete(id);
    },
    hasPointerCapture: (id: number) => captured.has(id),
  });

  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: MINIMAP_WIDTH_PX,
    bottom: MINIMAP_HEIGHT_PX,
    width: MINIMAP_WIDTH_PX,
    height: MINIMAP_HEIGHT_PX,
    toJSON: () => ({}),
  });
}

let frames: ReturnType<typeof stubAnimationFrame>;
let context: ReturnType<typeof stubCanvasContext>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  context = stubCanvasContext();
  frames = stubAnimationFrame();
  resetCanvasStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  frames.restore();
  resetCanvasStore();
});

describe('visibility', () => {
  it('renders nothing while the panel is toggled off', () => {
    render(<Minimap />);
    expect(screen.queryByRole('region', { name: 'Minimap' })).not.toBeInTheDocument();
  });

  it('mounts a canvas and its controls when toggled on', () => {
    seedDocument();
    showMinimap();
    render(<Minimap />);

    expect(screen.getByRole('region', { name: 'Minimap' })).toBeInTheDocument();
    // Decorative: the map is pixels of content a screen reader cannot read, and
    // the layers panel is the accessible representation.
    expect(mapSurface()).toHaveAttribute('aria-hidden', 'true');
    // The controls around it are not decorative and must stay reachable.
    expect(screen.getByRole('button', { name: 'Zoom to fit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide minimap' })).toBeInTheDocument();
  });

  it('hides itself through the store, so the toolbar toggle agrees', () => {
    seedDocument();
    showMinimap();
    render(<Minimap />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide minimap' }));

    expect(state().panels.minimap).toBe(false);
    expect(screen.queryByRole('region', { name: 'Minimap' })).not.toBeInTheDocument();
  });
});

describe('invalidation', () => {
  it('repaints only the viewport overlay while the camera moves', () => {
    seedDocument();
    showMinimap();
    render(<Minimap />);
    act(() => {
      frames.flush();
    });

    const documentPaints = context.paints(DOCUMENT_SURFACE);
    const overlayPaints = context.paints(OVERLAY_SURFACE);
    expect(documentPaints).toBeGreaterThan(0);

    act(() => {
      // Sixty frames of a pan.
      for (let i = 0; i < 60; i += 1) state().panBy(3, 1);
      frames.flush();
      vi.advanceTimersByTime(1000);
      frames.flush();
    });

    // Not one repaint of the 40-element document…
    expect(context.paints(DOCUMENT_SURFACE)).toBe(documentPaints);
    // …and the overlay's sixty invalidations coalesce into one pass per frame,
    // which is two here because the act block flushes twice.
    const overlayPasses = context.paints(OVERLAY_SURFACE) - overlayPaints;
    expect(overlayPasses).toBeGreaterThan(0);
    expect(overlayPasses).toBeLessThanOrEqual(2);
  });

  it('repaints the document when it changes, at most once per interval', () => {
    seedDocument();
    showMinimap();
    render(<Minimap />);
    act(() => {
      frames.flush();
      vi.advanceTimersByTime(500);
      frames.flush();
    });

    const before = context.paints(DOCUMENT_SURFACE);
    const id = state().elements.order[0];

    act(() => {
      // Sixty frames of an element drag: sixty document identities.
      for (let i = 0; i < 60; i += 1) state().updateElement(id!, { x: i });
      vi.advanceTimersByTime(50);
      frames.flush();
    });

    // One coalesced repaint for sixty document changes, not sixty.
    expect(context.paints(DOCUMENT_SURFACE) - before).toBeLessThanOrEqual(1);

    act(() => {
      vi.advanceTimersByTime(1000);
      frames.flush();
    });
    // …and the trailing render guarantees the map is never left stale.
    expect(context.paints(DOCUMENT_SURFACE)).toBeGreaterThan(before);
  });
});

/**
 * `ElementStore.order` names root ids only, so a group's members are reachable
 * only through a tree walk. The minimap draws the whole document and frames it
 * on its own bounds, so it gets both halves of that wrong at once.
 */
describe('grouped content', () => {
  /** Two rects in a group; the far one hidden. Returns the visible one's rect. */
  function groupWithHiddenMember(): void {
    const shown = createRectangle(worldRect(0, 0, 200, 200));
    const away = createRectangle(worldRect(2000, 2000, 200, 200));
    state().addElements([shown, away]);
    if (state().group([shown.id, away.id]) === null) throw new Error('grouping failed');
    state().toggleVisible(away.id);
    state().setViewportSize(800, 600);
  }

  it('draws the members, not the group that paints nothing', () => {
    const a = createRectangle(worldRect(0, 0, 100, 100));
    const b = createRectangle(worldRect(200, 200, 100, 100));
    state().addElements([a, b]);
    if (state().group([a.id, b.id]) === null) throw new Error('grouping failed');
    state().setViewportSize(1200, 800);
    showMinimap();

    render(<Minimap />);
    act(() => {
      frames.flush();
    });

    // A walk over `order` hands the renderer one group element, whose drawer is
    // empty by design - the map would come out blank.
    expect(state().elements.order).toHaveLength(1);
    expect(context.shapeFills(DOCUMENT_SURFACE)).toBeGreaterThanOrEqual(2);
  });

  it('fits on what paints rather than on the group’s cached box', () => {
    groupWithHiddenMember();
    showMinimap();
    render(<Minimap />);
    act(() => {
      frames.flush();
      fireEvent.click(screen.getByRole('button', { name: 'Zoom to fit' }));
    });

    // The group's box spans the hidden member too, so measuring the container
    // would frame 2,200 units of mostly nothing.
    expect(state().viewport).toEqual(viewportToFit({ x: 0, y: 0, width: 200, height: 200 }, 800, 600));
  });
});

describe('navigation', () => {
  beforeEach(() => {
    stubSurfaceRect();
  });

  it('recentres the camera on a click outside the viewport rectangle', () => {
    seedDocument(60);
    showMinimap();
    render(<Minimap />);
    act(() => {
      frames.flush();
    });

    const before = state().viewport;
    act(() => {
      fireEvent.pointerDown(mapSurface(), { button: 0, pointerId: 1, clientX: 8, clientY: 8 });
    });
    const after = state().viewport;

    // A jump, at unchanged zoom: a minimap moves the camera, not the lens.
    expect(after.zoom).toBe(before.zoom);
    expect(after.panX !== before.panX || after.panY !== before.panY).toBe(true);
  });

  it('drags the camera by the pointer delta rather than snapping it under the cursor', () => {
    seedDocument(60);
    showMinimap();
    // Frame the document so the viewport rectangle covers the middle of the map,
    // which is what makes the press below land *inside* it.
    render(<Minimap />);
    act(() => {
      frames.flush();
      fireEvent.click(screen.getByRole('button', { name: 'Zoom to fit' }));
      frames.flush();
    });

    const before = state().viewport;
    const surface = mapSurface();

    act(() => {
      fireEvent.pointerDown(surface, {
        button: 0,
        pointerId: 1,
        clientX: MINIMAP_WIDTH_PX / 2,
        clientY: MINIMAP_HEIGHT_PX / 2,
      });
    });

    // Pressing inside the rectangle grabs it: nothing moves until the pointer does.
    expect(state().viewport).toEqual(before);

    act(() => {
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: MINIMAP_WIDTH_PX / 2 + 20,
        clientY: MINIMAP_HEIGHT_PX / 2,
      });
      fireEvent.pointerUp(surface, { pointerId: 1 });
    });

    const after = state().viewport;
    // Dragging right moves the camera right, so the content slides left: pan
    // decreases. The magnitude is the minimap delta scaled by the zoom ratio,
    // which is what makes the gesture feel like moving a camera.
    expect(after.panX).toBeLessThan(before.panX);
    expect(after.zoom).toBe(before.zoom);
  });

  it('ignores non-primary buttons', () => {
    seedDocument(60);
    showMinimap();
    render(<Minimap />);
    act(() => {
      frames.flush();
    });

    const before = state().viewport;
    act(() => {
      fireEvent.pointerDown(mapSurface(), { button: 2, pointerId: 1, clientX: 4, clientY: 4 });
    });

    expect(state().viewport).toEqual(before);
  });
});

/**
 * The claim from `docs/architecture.md` §5 and §11, measured across the panels
 * rather than asserted: a pan must not run the reconciler anywhere. The canvas
 * stage has its own version of this test; this one covers everything else that
 * is on screen at the same time.
 */
describe('React work during a pan', () => {
  it('re-renders no panel, no toolbar and no minimap', () => {
    seedDocument(200);
    showMinimap();
    state().select([state().elements.order[0]!]);

    const commits: string[] = [];
    const record =
      (id: string): ProfilerOnRenderCallback =>
      (_id, phase) => {
        commits.push(`${id}:${phase}`);
      };

    // The toolbar carries a router Link (the home logo), so it needs a router
    // in the tree. Memory history keeps this a unit test rather than dragging
    // the real route table in.
    render(
      <MemoryRouter>
        <Profiler id="toolbar" onRender={record('toolbar')}>
          <Toolbar />
        </Profiler>
        <Profiler id="properties" onRender={record('properties')}>
          <PropertiesPanel />
        </Profiler>
        <Profiler id="layers" onRender={record('layers')}>
          <LayersPanel />
        </Profiler>
        <Profiler id="minimap" onRender={record('minimap')}>
          <Minimap />
        </Profiler>
      </MemoryRouter>
    );

    act(() => {
      frames.flush();
    });
    commits.length = 0;

    act(() => {
      for (let i = 0; i < 60; i += 1) state().panBy(4, 2);
      frames.flush();
    });

    expect(commits).toEqual([]);
  });
});
