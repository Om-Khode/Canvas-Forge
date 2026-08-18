/**
 * jsdom has no 2D canvas context, so nothing here asserts on pixels. What is
 * tested is what can actually be got wrong without noticing: the padded bounds,
 * the scale clamp against the browser's canvas limits, the fitted viewport, and
 * the decode gate that stops an export shipping without its images.
 */

import { describe, expect, it, vi } from 'vitest';
import { awaitImageDecodes, exportPng, planPngExport, planPngExportFor, pngFilename } from './png';
import { createRectangle, createImage } from '@/features/elements/factory';
import type { CanvasElement, WorldRect } from '@/types';

function rect(x: number, y: number, width: number, height: number): WorldRect {
  return { x, y, width, height } as WorldRect;
}

function box(x: number, y: number, width: number, height: number): CanvasElement {
  return createRectangle(rect(x, y, width, height));
}

const NO_PADDING = { padding: 0 };

describe('planPngExport', () => {
  it('pads the bounds on every side', () => {
    const plan = planPngExport({ x: 0, y: 0, width: 100, height: 50 }, { padding: 10, scale: 1 });

    expect(plan.worldBounds).toEqual({ x: -10, y: -10, width: 120, height: 70 });
    expect(plan.widthPx).toBe(120);
    expect(plan.heightPx).toBe(70);
  });

  it('multiplies the pixel size by the scale factor', () => {
    const plan = planPngExport(
      { x: 0, y: 0, width: 200, height: 100 },
      { ...NO_PADDING, scale: 3 }
    );

    expect(plan.scale).toBe(3);
    expect(plan.widthPx).toBe(600);
    expect(plan.heightPx).toBe(300);
    expect(plan.clamped).toBe(false);
  });

  it('produces a viewport that maps the padded bounds onto the pixel rect', () => {
    const plan = planPngExport(
      { x: 40, y: -20, width: 200, height: 100 },
      { ...NO_PADDING, scale: 2 }
    );
    const { viewport } = plan;

    expect(viewport.zoom).toBeCloseTo(2, 10);
    // world top-left → pixel (0, 0), world bottom-right → (widthPx, heightPx).
    expect(plan.worldBounds.x * viewport.zoom + viewport.panX).toBeCloseTo(0, 8);
    expect(plan.worldBounds.y * viewport.zoom + viewport.panY).toBeCloseTo(0, 8);
    expect(
      (plan.worldBounds.x + plan.worldBounds.width) * viewport.zoom + viewport.panX
    ).toBeCloseTo(plan.widthPx, 8);
    expect(
      (plan.worldBounds.y + plan.worldBounds.height) * viewport.zoom + viewport.panY
    ).toBeCloseTo(plan.heightPx, 8);
  });

  it('clamps the scale to the per-side canvas limit and reports it', () => {
    const plan = planPngExport(
      { x: 0, y: 0, width: 5000, height: 100 },
      { ...NO_PADDING, scale: 3, maxDimension: 6000, maxArea: Number.POSITIVE_INFINITY }
    );

    expect(plan.requestedScale).toBe(3);
    expect(plan.scale).toBeCloseTo(6000 / 5000, 10);
    expect(plan.widthPx).toBe(6000);
    expect(plan.clamped).toBe(true);
  });

  it('clamps the scale to the total-area limit', () => {
    const plan = planPngExport(
      { x: 0, y: 0, width: 1000, height: 1000 },
      { ...NO_PADDING, scale: 3, maxDimension: Number.POSITIVE_INFINITY, maxArea: 4_000_000 }
    );

    // sqrt(4e6 / 1e6) = 2, so a 3x request becomes 2x.
    expect(plan.scale).toBeCloseTo(2, 10);
    expect(plan.widthPx * plan.heightPx).toBeLessThanOrEqual(4_000_000);
    expect(plan.clamped).toBe(true);
  });

  it('never produces a zero-pixel canvas for a degenerate rect', () => {
    const plan = planPngExport({ x: 0, y: 0, width: 100, height: 0 }, { ...NO_PADDING, scale: 1 });

    expect(plan.heightPx).toBe(1);
  });
});

describe('planPngExportFor', () => {
  it('returns null when there is nothing visible', () => {
    expect(planPngExportFor([])).toBeNull();
    expect(planPngExportFor([{ ...box(0, 0, 10, 10), visible: false }])).toBeNull();
  });

  it('frames the union of the given elements', () => {
    const plan = planPngExportFor([box(0, 0, 100, 100), box(200, 50, 100, 100)], NO_PADDING);

    expect(plan?.worldBounds).toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });
});

describe('awaitImageDecodes', () => {
  it('returns immediately when every key is already decoded', async () => {
    const subscribeImages = vi.fn(() => () => undefined);

    await awaitImageDecodes(['a', 'b'], {
      resolveImage: () => ({}) as CanvasImageSource,
      subscribeImages,
    });

    expect(subscribeImages).not.toHaveBeenCalled();
  });

  it('waits for a pending decode to be notified', async () => {
    // A holder rather than a bare `let`: the compiler narrows a variable only
    // assigned inside a callback to `null` at every later read.
    const bus: { notify: ((key: string) => void) | null } = { notify: null };
    const decoded = new Set<string>();

    const pending = awaitImageDecodes(['slow'], {
      resolveImage: (key) => (decoded.has(key) ? ({} as CanvasImageSource) : null),
      subscribeImages: (listener) => {
        bus.notify = listener;
        return () => {
          bus.notify = null;
        };
      },
    });

    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    decoded.add('slow');
    bus.notify?.('slow');
    await pending;
    expect(done).toBe(true);
  });

  it('gives up after the timeout rather than hanging on a decode that never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = awaitImageDecodes(['gone'], {
        resolveImage: () => null,
        subscribeImages: () => () => undefined,
        decodeTimeoutMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('exportPng', () => {
  const fakeCanvas = (): HTMLCanvasElement => ({}) as HTMLCanvasElement;
  const fakeBlob = (): Blob => ({ size: 1, type: 'image/png' }) as Blob;

  it('reports an empty document rather than producing a blank image', async () => {
    const result = await exportPng({ elements: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('empty');
  });

  it('paints a scene with no selection chrome and returns the encoded blob', async () => {
    const paint = vi.fn();

    const result = await exportPng(
      { elements: [box(0, 0, 100, 100)], scale: 2, padding: 0, background: '#ffffff' },
      {
        createCanvas: fakeCanvas,
        paint,
        encode: () => Promise.resolve(fakeBlob()),
        resolveImage: () => null,
        subscribeImages: () => () => undefined,
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.widthPx).toBe(200);
      expect(result.value.heightPx).toBe(200);
      expect(result.value.clampedFrom).toBeNull();
    }

    const scene = paint.mock.calls[0]?.[1] as {
      selectedIds: Set<string>;
      interaction: { kind: string };
    };
    expect(scene.selectedIds.size).toBe(0);
    expect(scene.interaction.kind).toBe('idle');
    expect(paint.mock.calls[0]?.[2]).toMatchObject({ background: '#ffffff' });
  });

  it('waits for image decodes before painting', async () => {
    const decoded = new Set<string>();
    const bus: { notify: ((key: string) => void) | null } = { notify: null };
    const order: string[] = [];

    const image = createImage(rect(0, 0, 100, 100), {
      imageKey: 'blob-key',
      naturalWidth: 100,
      naturalHeight: 100,
    });

    const pending = exportPng(
      { elements: [image], padding: 0 },
      {
        createCanvas: fakeCanvas,
        paint: () => {
          order.push('paint');
        },
        encode: () => Promise.resolve(fakeBlob()),
        resolveImage: (key) => (decoded.has(key) ? ({} as CanvasImageSource) : null),
        subscribeImages: (listener) => {
          bus.notify = listener;
          return () => {
            bus.notify = null;
          };
        },
      }
    );

    await Promise.resolve();
    expect(order).toEqual([]);

    decoded.add('blob-key');
    order.push('decoded');
    bus.notify?.('blob-key');

    await pending;
    expect(order).toEqual(['decoded', 'paint']);
  });

  it('surfaces an encode failure instead of resolving with nothing', async () => {
    const result = await exportPng(
      { elements: [box(0, 0, 10, 10)] },
      {
        createCanvas: fakeCanvas,
        paint: () => undefined,
        encode: () => Promise.resolve(null),
        resolveImage: () => null,
        subscribeImages: () => () => undefined,
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('encode-failed');
  });

  it('reports the scale it was forced down to', async () => {
    const result = await exportPng(
      { elements: [box(0, 0, 5000, 100)], scale: 3, padding: 0, maxDimension: 6000 },
      {
        createCanvas: fakeCanvas,
        paint: () => undefined,
        encode: () => Promise.resolve(fakeBlob()),
        resolveImage: () => null,
        subscribeImages: () => () => undefined,
      }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clampedFrom).toBe(3);
      expect(result.value.widthPx).toBe(6000);
    }
  });
});

describe('pngFilename', () => {
  it('slugifies the project name', () => {
    expect(pngFilename('My Design!')).toBe('my-design.png');
  });

  it('falls back when the name has nothing usable in it', () => {
    expect(pngFilename('   ')).toBe('canvasforge-project.png');
  });
});
