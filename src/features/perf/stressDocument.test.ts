import { beforeEach, describe, expect, it } from 'vitest';

import { hitTestPoint } from '@/features/canvas/engine/hitTest';
import { elementsInPaintOrder } from '@/features/elements/tree';
import { elementBounds, contentBounds } from '@/features/selection/bounds';
import { elementsInOrder, resetCanvasStore, useCanvasStore } from '@/store';
import type { CanvasElement, ElementId, ElementType, Viewport } from '@/types';
import { visibleWorldRect, worldPoint } from '@/utils/coords';
import { rectCenter, rectsIntersect } from '@/utils/geometry';
import { benchmark, formatResult, ratio } from './benchmark';
import {
  createStressDocument,
  createStressElements,
  DEFAULT_STRESS_COUNT,
  MAX_STRESS_COUNT,
  parseStressCount,
} from './stressDocument';

/**
 * Two kinds of test live in this file and the difference is deliberate.
 *
 * The first half asserts the generator's *contract* - seeded, complete, valid -
 * because a benchmark run against a document that quietly changed between runs
 * measures nothing.
 *
 * The second half is the measurement itself. Those assertions are bounds an
 * order of magnitude looser than the observed numbers: their job is to catch a
 * regression that changes the shape of the cost (linear → quadratic, shared →
 * cloned), not to fail because CI is running on a busy machine. The precise
 * numbers are printed and recorded in `docs/performance.md`, which is where
 * exact figures belong - a test that asserts "hit-testing takes 0.21ms" is a
 * test that fails on someone else's laptop.
 */

const state = () => useCanvasStore.getState();

/** Standard laptop canvas, used for every viewport-dependent measurement here. */
const VIEWPORT_PX = { width: 1440, height: 900 } as const;

/**
 * The measured numbers are the output of this file. Printed rather than only
 * asserted: a benchmark whose figures nobody can read is a benchmark nobody
 * checks, and these are the figures `docs/performance.md` quotes.
 * Run with `npx vitest run src/features/perf --disableConsoleIntercept`.
 */
function report(line: string): void {
  console.info(`  ⏱  ${line}`);
}

/** A viewport at `zoom`, centred on the document's content. */
function viewportCentredOn(elements: readonly CanvasElement[], zoom: number): Viewport {
  const bounds = contentBounds(elements);
  const centre = bounds === null ? { x: 0, y: 0 } : rectCenter(bounds);
  return {
    zoom,
    panX: VIEWPORT_PX.width / 2 - centre.x * zoom,
    panY: VIEWPORT_PX.height / 2 - centre.y * zoom,
  };
}

/**
 * The renderer's cull predicate, run over a whole document. Uses exactly the
 * functions `Renderer.render` uses - `visibleWorldRect`, the rotation-aware
 * bounds, `rectsIntersect` - so the fraction reported is the fraction the
 * renderer would actually draw, not an approximation of it.
 */
function visibleFraction(elements: readonly CanvasElement[], viewport: Viewport): number {
  const visible = visibleWorldRect(VIEWPORT_PX.width, VIEWPORT_PX.height, viewport);
  let drawn = 0;
  for (const element of elements) {
    if (!element.visible) continue;
    if (rectsIntersect(visible, elementBounds(element))) drawn += 1;
  }
  return drawn / elements.length;
}

describe('the generated document', () => {
  it('is reproducible from its seed', () => {
    const a = createStressElements({ count: 50, seed: 7 });
    const b = createStressElements({ count: 50, seed: 7 });
    const different = createStressElements({ count: 50, seed: 8 });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(different)).not.toBe(JSON.stringify(a));
  });

  it('produces the requested count with unique ids in paint order', () => {
    const document = createStressDocument({ count: 300 });

    expect(document.order).toHaveLength(300);
    expect(new Set(document.order).size).toBe(300);
    for (const id of document.order) expect(document.byId[id]).toBeDefined();
  });

  it('covers every element type the generator claims to (all but image)', () => {
    const types = new Set<ElementType>(
      createStressElements({ count: 400 }).map((element) => element.type)
    );

    expect(types).toEqual(
      new Set<ElementType>(['rectangle', 'ellipse', 'text', 'line', 'arrow', 'freehand'])
    );
    // Images reference a blob that would have to exist in IndexedDB; including
    // them would benchmark the renderer's placeholder path.
    expect(types.has('image')).toBe(false);
  });

  it('produces finite, non-degenerate geometry with a mix of rotations', () => {
    const elements = createStressElements({ count: 500 });

    for (const element of elements) {
      expect(Number.isFinite(element.x)).toBe(true);
      expect(Number.isFinite(element.y)).toBe(true);
      expect(element.width).toBeGreaterThan(0);
      expect(element.height).toBeGreaterThan(0);
      expect(element.opacity).toBeGreaterThan(0);
      expect(element.opacity).toBeLessThanOrEqual(1);
    }

    const rotated = elements.filter((element) => element.rotation !== 0).length;
    expect(rotated).toBeGreaterThan(0);
    // Most shapes stay axis-aligned, which is what `rotatedBounds`' fast path
    // assumes about real documents.
    expect(rotated).toBeLessThan(elements.length / 2);
  });

  it('spreads content over a large world area rather than piling it at the origin', () => {
    const bounds = contentBounds(createStressElements({ count: DEFAULT_STRESS_COUNT }));
    expect(bounds).not.toBeNull();
    expect(bounds?.width ?? 0).toBeGreaterThan(3000);
    expect(bounds?.height ?? 0).toBeGreaterThan(2000);
  });
});

describe('parseStressCount', () => {
  it('reads a count, defaults a bare flag, and rejects nonsense', () => {
    expect(parseStressCount('2000')).toBe(2000);
    expect(parseStressCount('')).toBe(DEFAULT_STRESS_COUNT);
    expect(parseStressCount(null)).toBeNull();
    expect(parseStressCount('nope')).toBeNull();
    expect(parseStressCount('0')).toBeNull();
    expect(parseStressCount('-5')).toBeNull();
  });

  it('caps a fat-fingered count instead of hanging the tab', () => {
    expect(parseStressCount('999999')).toBe(MAX_STRESS_COUNT);
  });
});

/* ------------------------------------------------------------ measurement -- */

describe('hit-testing cost (the linear scan architecture.md §11 defers a quadtree for)', () => {
  const big = createStressElements({ count: 2000 });
  const small = createStressElements({ count: 200 });
  const viewport = viewportCentredOn(big, 1);

  it('scales linearly with document size - the scan is not culled', () => {
    // A miss is the worst case: a hit returns as soon as it finds one, a miss
    // walks every element in the document. The editor hit-tests on every
    // pointermove while idle (`probeUnderPointer`), so this is a hover-path cost.
    const missPoint = worldPoint(-500_000, -500_000);

    const at2000 = benchmark('hit-test miss @2,000', () => hitTestPoint(missPoint, big, viewport));
    const at200 = benchmark('hit-test miss @200', () => hitTestPoint(missPoint, small, viewport));

    report(formatResult(at2000));
    report(formatResult(at200));
    report(`hit-test 2,000 ÷ 200 = ${ratio(at2000, at200).toFixed(1)}×`);

    /*
     * Asserted as cost *per element*, not as the ratio between the two runs.
     *
     * The ratio is the more direct expression of "this is linear", and it is
     * also the flakier one: the 200-element case runs in tens of microseconds,
     * so under a loaded machine - the full suite running in parallel - a single
     * scheduling hiccup in the denominator swings the ratio wildly. This test
     * failed exactly that way once, under full-suite load, and passed in
     * isolation. A timing assertion that fails for reasons unrelated to the
     * code is worse than no assertion, because it teaches you to re-run.
     *
     * The measured cost is ~0.3µs/element. The bound below is 30× that, which
     * a loaded CI box will not trip but a quadratic regression cannot survive:
     * at 2,000 elements, quadratic would be roughly three orders of magnitude
     * over. The ratio is still computed and reported - it is the interesting
     * number to read - it just isn't what gates the suite.
     */
    const microsecondsPerElement = (at2000.median / big.length) * 1000;
    expect(microsecondsPerElement).toBeLessThan(10);
  });

  it('measures the array the hit test walks, which is rebuilt per pointermove', () => {
    // `probeUnderPointer` calls `elementsInPaintOrder(store.elements)` before
    // every hit test, so the hover path allocates a 2,000-entry array per
    // pointermove. Whether that matters is a number, not an opinion.
    //
    // Both are measured: this document is flat, so the two walks visit the same
    // elements and the difference is the cost of the tree walk's `visited` set
    // rather than of any extra work it finds.
    const document = createStressDocument({ count: 2000 });
    report(formatResult(benchmark('elementsInOrder @2,000', () => elementsInOrder(document))));
    const result = benchmark('elementsInPaintOrder @2,000', () => elementsInPaintOrder(document));

    report(formatResult(result));
    expect(result.median).toBeLessThan(5);
  });

  it('stays fast when the topmost element is hit immediately', () => {
    const top = big[big.length - 1];
    expect(top).toBeDefined();
    const centre = worldPoint(top!.x + top!.width / 2, top!.y + top!.height / 2);

    const result = benchmark('hit-test top element @2,000', () =>
      hitTestPoint(centre, big, viewport)
    );
    report(formatResult(result));
    expect(result.median).toBeLessThan(5);
  });
});

describe('culling effectiveness', () => {
  const elements = createStressElements({ count: DEFAULT_STRESS_COUNT });

  it('draws a small fraction of the document at 100% zoom', () => {
    const fraction = visibleFraction(elements, viewportCentredOn(elements, 1));
    report(
      `culled @100%: ${(fraction * 100).toFixed(1)}% of ${DEFAULT_STRESS_COUNT} elements drawn ` +
        `(${Math.round(fraction * DEFAULT_STRESS_COUNT)} of them)`
    );
    expect(fraction).toBeLessThan(0.2);
  });

  it('degrades to drawing everything when the whole document is framed', () => {
    // Zoom-to-fit is the honest worst case and the number the frame budget has
    // to survive: nothing is off screen, so the cull saves nothing.
    const zoom = Math.min(
      VIEWPORT_PX.width / (contentBounds(elements)?.width ?? 1),
      VIEWPORT_PX.height / (contentBounds(elements)?.height ?? 1)
    );
    const fraction = visibleFraction(elements, viewportCentredOn(elements, zoom));
    report(`culled @fit (${(zoom * 100).toFixed(1)}%): ${(fraction * 100).toFixed(1)}% drawn`);
    expect(fraction).toBeGreaterThan(0.9);
  });

  it('costs one AABB test per element to decide', () => {
    const viewport = viewportCentredOn(elements, 1);
    const result = benchmark('cull pass @2,000', () => visibleFraction(elements, viewport));
    report(formatResult(result));
    expect(result.median).toBeLessThan(5);
  });
});

describe('history memory (the structural-sharing claim, as an assertion)', () => {
  beforeEach(() => {
    resetCanvasStore();
  });

  it('shares every untouched element between snapshots', () => {
    const document = createStressDocument({ count: DEFAULT_STRESS_COUNT });
    state().replaceDocument(document);

    const before = state().elements;
    const movedId = before.order[1000];
    expect(movedId).toBeDefined();

    state().updateElement(movedId as ElementId, { x: 999 }, 'Move element');
    const after = state().elements;

    let shared = 0;
    for (const id of after.order) {
      if (after.byId[id] === before.byId[id]) shared += 1;
    }

    // 1,999 of 2,000 element objects are the *same objects*, not copies.
    expect(shared).toBe(DEFAULT_STRESS_COUNT - 1);
    expect(after.byId[movedId as ElementId]).not.toBe(before.byId[movedId as ElementId]);
    // The z-order array is untouched by a move, so it is reused wholesale.
    expect(after.order).toBe(before.order);
    // And the undo entry holds one pointer to the previous document, not a copy.
    expect(state().history.past.at(-1)?.snapshot).toBe(before);
  });

  it('costs one element object per undo step, not one document per undo step', () => {
    const document = createStressDocument({ count: DEFAULT_STRESS_COUNT });
    state().replaceDocument(document);

    const steps = 50;
    for (let i = 0; i < steps; i += 1) {
      const id = state().elements.order[i];
      state().updateElement(id as ElementId, { x: i * 3 }, 'Move element');
    }

    // Every distinct element object reachable from the whole timeline.
    const live = new Set<CanvasElement>();
    for (const entry of state().history.past) {
      for (const id of entry.snapshot.order) {
        const element = entry.snapshot.byId[id];
        if (element !== undefined) live.add(element);
      }
    }
    for (const id of state().elements.order) {
      const element = state().elements.byId[id];
      if (element !== undefined) live.add(element);
    }

    // 2,000 originals plus one new object per edit. Deep-copying snapshots would
    // make this 51 × 2,000 = 102,000.
    expect(live.size).toBe(DEFAULT_STRESS_COUNT + steps);
    report(
      `history: ${steps} edits over ${DEFAULT_STRESS_COUNT} elements → ${live.size} live element ` +
        `objects (deep copies would be ${(steps + 1) * DEFAULT_STRESS_COUNT})`
    );
  });

  it('generates the stress document fast enough to be a dev affordance', () => {
    const result = benchmark(
      `generate ${DEFAULT_STRESS_COUNT} elements`,
      () => createStressDocument({ count: DEFAULT_STRESS_COUNT }),
      { iterations: 10, warmup: 2 }
    );
    report(formatResult(result, 1));
    expect(result.median).toBeLessThan(2000);
  });
});
