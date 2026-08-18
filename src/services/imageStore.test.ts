import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from '@/constants/defaults';
import { STORE_IMAGES } from '@/constants/storage';
import { createMemoryBackend, type StorageBackend } from './idb';
import { createImageStore, type ImageCodec } from './imageStore';

/**
 * The browser codec cannot run under jsdom - there is no 2D context and no
 * `createImageBitmap` - so the codec is injected. That draws the line honestly:
 * these tests cover the ingest *policy* (type allow-list, size cap, hashing,
 * dedupe, downscale arithmetic) and make no claim about the browser's decoder.
 */
function stubCodec(
  width: number,
  height: number,
  resized: Blob | null = new Blob(['small'])
): ImageCodec {
  return {
    measure: () => Promise.resolve({ width, height }),
    resize: () => Promise.resolve(resized),
  };
}

function png(content: string): Blob {
  return new Blob([content], { type: 'image/png' });
}

/** Wraps a backend so the tests can assert how often it was touched. */
function counting(
  inner: StorageBackend
): StorageBackend & { gets: () => number; puts: () => number } {
  let gets = 0;
  let puts = 0;
  return {
    get: (store, key) => {
      gets++;
      return inner.get(store, key);
    },
    getAll: (store) => inner.getAll(store),
    getAllKeys: (store) => inner.getAllKeys(store),
    put: (store, key, value) => {
      puts++;
      return inner.put(store, key, value);
    },
    delete: (store, key) => inner.delete(store, key),
    gets: () => gets,
    puts: () => puts,
  };
}

describe('storeImage - ingest policy', () => {
  it('rejects a type outside the allow-list', async () => {
    const store = createImageStore({ backend: createMemoryBackend(), codec: stubCodec(10, 10) });
    const result = await store.storeImage(new Blob(['<svg/>'], { type: 'image/bmp' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unsupported-type');
  });

  it('rejects a file over the size cap without decoding it', async () => {
    const codec = stubCodec(10, 10);
    const measure = vi.spyOn(codec, 'measure');
    const store = createImageStore({ backend: createMemoryBackend(), codec });

    const huge = png('x');
    Object.defineProperty(huge, 'size', { value: MAX_IMAGE_BYTES + 1 });

    const result = await store.storeImage(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('too-large');
    expect(measure).not.toHaveBeenCalled();
  });

  it('reports a decode failure rather than throwing', async () => {
    const store = createImageStore({
      backend: createMemoryBackend(),
      codec: {
        measure: () => Promise.reject(new Error('corrupt header')),
        resize: () => Promise.resolve(null),
      },
    });
    const result = await store.storeImage(png('junk'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('decode-failed');
    expect(result.error.message).toContain('corrupt header');
  });
});

describe('storeImage - content addressing', () => {
  it('stores identical content once and returns the same key', async () => {
    const backend = counting(createMemoryBackend());
    const store = createImageStore({ backend, codec: stubCodec(100, 50) });

    const first = await store.storeImage(png('same-bytes'));
    const second = await store.storeImage(png('same-bytes'));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.key).toBe(first.value.key);
    expect(backend.puts()).toBe(1);

    const keys = await backend.getAllKeys(STORE_IMAGES);
    expect(keys.ok && keys.value).toHaveLength(1);
  });

  it('gives different content different keys', async () => {
    const store = createImageStore({ backend: createMemoryBackend(), codec: stubCodec(10, 10) });
    const a = await store.storeImage(png('alpha'));
    const b = await store.storeImage(png('beta'));
    expect(a.ok && b.ok && a.value.key !== b.value.key).toBe(true);
  });
});

describe('storeImage - downscaling', () => {
  it('scales the long edge down to the limit and preserves aspect ratio', async () => {
    const store = createImageStore({
      backend: createMemoryBackend(),
      codec: stubCodec(MAX_IMAGE_DIMENSION * 2, MAX_IMAGE_DIMENSION),
    });
    const result = await store.storeImage(png('big'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.width).toBe(MAX_IMAGE_DIMENSION);
    expect(result.value.height).toBe(MAX_IMAGE_DIMENSION / 2);
  });

  it('leaves an image under the limit untouched', async () => {
    const codec = stubCodec(800, 600);
    const resize = vi.spyOn(codec, 'resize');
    const store = createImageStore({ backend: createMemoryBackend(), codec });

    const result = await store.storeImage(png('small'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ width: 800, height: 600 });
    expect(resize).not.toHaveBeenCalled();
  });

  it('keeps the original dimensions when the codec declines to resize', async () => {
    const store = createImageStore({
      backend: createMemoryBackend(),
      // A GIF or SVG: the browser codec returns null rather than rasterising it.
      codec: stubCodec(MAX_IMAGE_DIMENSION * 3, MAX_IMAGE_DIMENSION * 3, null),
    });
    const result = await store.storeImage(png('animated'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.width).toBe(MAX_IMAGE_DIMENSION * 3);
  });
});

describe('resolveImage', () => {
  it('returns null on a miss and notifies subscribers when the decode settles', async () => {
    const store = createImageStore({ backend: createMemoryBackend(), codec: stubCodec(10, 10) });
    const seen: string[] = [];
    const unsubscribe = store.subscribe((key) => seen.push(key));

    expect(store.resolveImage('missing-key')).toBeNull();
    await vi.waitFor(() => {
      expect(seen).toEqual(['missing-key']);
    });

    unsubscribe();
    store.clearCache();
    expect(store.resolveImage('missing-key')).toBeNull();
  });

  it('does not retry a key whose decode already failed', async () => {
    const backend = counting(createMemoryBackend());
    const store = createImageStore({ backend, codec: stubCodec(10, 10) });

    store.resolveImage('ghost');
    await vi.waitFor(() => {
      expect(backend.gets()).toBe(1);
    });

    // Simulates the renderer asking again on every frame.
    for (let i = 0; i < 10; i++) store.resolveImage('ghost');
    expect(backend.gets()).toBe(1);
  });
});

describe('getImageBlob / deleteImage', () => {
  it('round-trips a stored blob and removes it on delete', async () => {
    const backend = createMemoryBackend();
    const store = createImageStore({ backend, codec: stubCodec(10, 10) });

    const stored = await store.storeImage(png('bytes'));
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    const blob = await store.getImageBlob(stored.value.key);
    expect(blob.ok && blob.value).toBeInstanceOf(Blob);

    await store.deleteImage(stored.value.key);
    const gone = await store.getImageBlob(stored.value.key);
    expect(gone.ok && gone.value).toBeNull();
  });

  it('returns null rather than an error for a key that was never stored', async () => {
    const store = createImageStore({ backend: createMemoryBackend(), codec: stubCodec(10, 10) });
    const blob = await store.getImageBlob('nope');
    expect(blob.ok).toBe(true);
    if (!blob.ok) return;
    expect(blob.value).toBeNull();
  });
});
