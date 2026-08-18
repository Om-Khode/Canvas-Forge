import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, PASTE_OFFSET } from '@/constants';
import { createImage, createRectangle } from '@/features/elements/factory';
import { createMemoryBackend } from '@/services/idb';
import { createImageStore, type ImageCodec } from '@/services/imageStore';
import type * as ImageStoreModule from '@/services/imageStore';
import { elementsInOrder, resetCanvasStore, useCanvasStore } from '@/store';
import type { ImagePlacement } from './ingest';
import {
  clearImageError,
  fitImageSize,
  getImageError,
  imageFilesOf,
  ingestImageFile,
  ingestImageFiles,
  insertImageFiles,
  subscribeImageError,
} from './ingest';
import { worldPoint, worldRect } from '@/utils/coords';

/**
 * `insertImageFiles` never takes a `store` in its own `IngestContext` - it
 * always falls through to the `imageStore` singleton, which is exactly what
 * makes it untestable *without* this: the singleton's codec needs a real 2D
 * context, which jsdom does not have. Replacing the module's export with one
 * built from `createImageStore` (the same seam `imageStoreWith` below uses) is
 * what lets a test drive `insertImageFiles` itself - the actual production
 * entry point - instead of asserting on an expression fed to a lower-level
 * function that `insertImageFiles` merely happens to call today.
 */
vi.mock('@/services/imageStore', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageStoreModule>();
  const { createMemoryBackend: memoryBackend } = await import('@/services/idb');
  return {
    ...actual,
    imageStore: actual.createImageStore({
      backend: memoryBackend(),
      codec: {
        measure: () => Promise.resolve({ width: 100, height: 100 }),
        resize: () => Promise.resolve(null),
      },
    }),
  };
});

/**
 * The browser codec cannot run under jsdom - no 2D context, no
 * `createImageBitmap` - so it is injected, exactly as `imageStore.test` does.
 * What is under test here is the *placement* policy (viewport cap, aspect
 * ratio, cascade, naming) and the failure paths, not the browser's decoder.
 */
function stubCodec(width: number, height: number): ImageCodec {
  return {
    measure: () => Promise.resolve({ width, height }),
    resize: () => Promise.resolve(null),
  };
}

function imageStoreWith(width: number, height: number) {
  return createImageStore({ backend: createMemoryBackend(), codec: stubCodec(width, height) });
}

function png(name: string): File {
  return new File([name], name, { type: 'image/png' });
}

/** 1000×1000 CSS px of canvas at 100% zoom. */
const PLACEMENT: ImagePlacement = {
  viewport: { panX: 0, panY: 0, zoom: 1 },
  viewportSizePx: { width: 1000, height: 1000 },
};

const ORIGIN = worldPoint(0, 0);

describe('fitImageSize', () => {
  it('leaves an image that already fits at its natural size', () => {
    expect(fitImageSize({ width: 300, height: 200 }, PLACEMENT)).toEqual({
      width: 300,
      height: 200,
    });
  });

  it('caps an oversized image to a fraction of the viewport', () => {
    const size = fitImageSize({ width: 4000, height: 2000 }, PLACEMENT);
    expect(size.width).toBe(600);
    // 60% of 1000px, and the height follows the same factor.
    expect(size.height).toBe(300);
  });

  it('preserves the aspect ratio when capping', () => {
    const natural = { width: 4000, height: 3000 };
    const size = fitImageSize(natural, PLACEMENT);
    expect(size.width / size.height).toBeCloseTo(natural.width / natural.height, 10);
  });

  it('caps against the shorter axis so the whole image stays visible', () => {
    // Tall image: the height is what would overflow, so the height sets the cap.
    const size = fitImageSize({ width: 1000, height: 5000 }, PLACEMENT);
    expect(size.height).toBe(600);
    expect(size.width).toBe(120);
  });

  it('measures the cap in world units, so zoom does not change the apparent size', () => {
    const zoomed: ImagePlacement = {
      viewport: { panX: 0, panY: 0, zoom: 2 },
      viewportSizePx: { width: 1000, height: 1000 },
    };
    // At 2x zoom the visible world is half as wide, so the same 60% of the
    // screen is 300 world units rather than 600.
    expect(fitImageSize({ width: 4000, height: 4000 }, zoomed).width).toBe(300);
  });

  it('does not cap before the canvas has been measured', () => {
    const unmeasured: ImagePlacement = {
      viewport: { panX: 0, panY: 0, zoom: 1 },
      viewportSizePx: { width: 0, height: 0 },
    };
    expect(fitImageSize({ width: 4000, height: 100 }, unmeasured)).toEqual({
      width: 4000,
      height: 100,
    });
  });
});

describe('ingestImageFile', () => {
  it('rejects a file the store will not accept, with the store’s own message', async () => {
    const result = await ingestImageFile(
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      ORIGIN,
      { placement: PLACEMENT, store: imageStoreWith(10, 10) }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unsupported-type');
    expect(result.error.message).toMatch(/not a supported image type/i);
  });

  it('rejects a file over the byte cap', async () => {
    const huge = png('huge.png');
    Object.defineProperty(huge, 'size', { value: MAX_IMAGE_BYTES + 1 });

    const result = await ingestImageFile(huge, ORIGIN, {
      placement: PLACEMENT,
      store: imageStoreWith(10, 10),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('too-large');
  });

  it('reports a decode failure rather than throwing', async () => {
    const store = createImageStore({
      backend: createMemoryBackend(),
      codec: {
        measure: () => Promise.reject(new Error('corrupt header')),
        resize: () => Promise.resolve(null),
      },
    });

    const result = await ingestImageFile(png('broken.png'), ORIGIN, {
      placement: PLACEMENT,
      store,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('decode-failed');
  });

  it('builds an element that references the blob by key and never inlines pixels', async () => {
    const result = await ingestImageFile(png('photo.png'), ORIGIN, {
      placement: PLACEMENT,
      store: imageStoreWith(400, 200),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.value;

    expect(element.type).toBe('image');
    expect(element.imageKey.length).toBeGreaterThan(0);
    expect(element.naturalWidth).toBe(400);
    expect(element.naturalHeight).toBe(200);
    expect(element.alt).toBe('photo.png');
    // The whole memory argument: the element is a key, not a bitmap.
    expect(JSON.stringify(element).length).toBeLessThan(500);
  });

  it('centres the element on the point it was dropped at', async () => {
    const result = await ingestImageFile(png('photo.png'), worldPoint(100, 50), {
      placement: PLACEMENT,
      store: imageStoreWith(400, 200),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.x).toBe(100 - 200);
    expect(result.value.y).toBe(50 - 100);
  });

  it('sizes the element to the capped size, not the natural one', async () => {
    const result = await ingestImageFile(png('big.png'), ORIGIN, {
      placement: PLACEMENT,
      store: imageStoreWith(4000, 2000),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.width).toBe(600);
    expect(result.value.height).toBe(300);
    // The intrinsic size is still recorded, so aspect ratio survives a reload.
    expect(result.value.naturalWidth).toBe(4000);
  });
});

describe('ingestImageFiles', () => {
  it('cascades a batch instead of stacking it', async () => {
    const batch = await ingestImageFiles([png('a.png'), png('b.png')], ORIGIN, {
      placement: PLACEMENT,
      store: imageStoreWith(100, 100),
    });

    expect(batch.elements).toHaveLength(2);
    const [first, second] = batch.elements;
    expect(second?.x).toBe((first?.x ?? 0) + PASTE_OFFSET);
    expect(second?.y).toBe((first?.y ?? 0) + PASTE_OFFSET);
  });

  it('numbers the batch consecutively', async () => {
    const batch = await ingestImageFiles([png('a.png'), png('b.png')], ORIGIN, {
      placement: PLACEMENT,
      store: imageStoreWith(100, 100),
    });

    expect(batch.elements.map((element) => element.name)).toEqual(['Image 1', 'Image 2']);
  });

  it('keeps the good files when one of them fails', async () => {
    const batch = await ingestImageFiles(
      [png('good.png'), new File(['x'], 'notes.txt', { type: 'text/plain' })],
      ORIGIN,
      { placement: PLACEMENT, store: imageStoreWith(100, 100) }
    );

    expect(batch.elements).toHaveLength(1);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0]?.kind).toBe('unsupported-type');
  });
});

describe('imageFilesOf', () => {
  it('keeps only types the store can accept', () => {
    const files = [
      png('a.png'),
      new File(['x'], 'a.txt', { type: 'text/plain' }),
      new File(['x'], 'a.webp', { type: 'image/webp' }),
    ];
    expect(imageFilesOf(files).map((file) => file.name)).toEqual(['a.png', 'a.webp']);
  });
});

describe('insertImageFiles', () => {
  beforeEach(() => {
    resetCanvasStore();
    clearImageError();
  });

  it('surfaces a rejection instead of failing silently', async () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeImageError(() => {
      seen.push(getImageError());
    });

    await insertImageFiles([new File(['x'], 'notes.txt', { type: 'text/plain' })], ORIGIN);
    unsubscribe();

    expect(getImageError()).toMatch(/not a supported image type/i);
    expect(seen).toHaveLength(1);
    // Nothing was added, so the document is untouched.
    expect(useCanvasStore.getState().elements.order).toHaveLength(0);
  });

  it('does nothing at all for an empty selection', async () => {
    const batch = await insertImageFiles([], ORIGIN);
    expect(batch.elements).toHaveLength(0);
    expect(getImageError()).toBeNull();
  });

  /**
   * Goes through `insertImageFiles` itself, not `ingestImageFiles` - the real
   * production entry point, exercised against the mocked `imageStore` above
   * rather than the memory-backend `store` option every other test in this
   * file injects directly. A test that called `ingestImageFiles` and handed it
   * `elementsInPaintOrder(document)` by hand would pass whether or not
   * `insertImageFiles` itself ever computed that expression - which is
   * precisely the gap a review found in this test's first version.
   */
  it('names past an image that lives inside a group', async () => {
    const rect = createRectangle(worldRect(0, 0, 10, 10));
    const image = createImage(worldRect(20, 20, 10, 10), {
      imageKey: 'k',
      naturalWidth: 10,
      naturalHeight: 10,
      alt: '',
    });
    useCanvasStore.getState().addElements([rect, image]);
    useCanvasStore.getState().group([rect.id, image.id]);
    expect(image.name).toBe('Image 1');

    const document = useCanvasStore.getState().elements;
    // The premise: after grouping, the root order is the group alone, so a
    // walk that can only see roots finds no images at all and would hand out
    // "Image 1" a second time.
    expect(elementsInOrder(document).some((element) => element.type === 'image')).toBe(false);

    const batch = await insertImageFiles([png('b.png')], ORIGIN);

    expect(batch.errors).toHaveLength(0);
    expect(batch.elements[0]?.name).toBe('Image 2');
  });
});
