/**
 * Image blob storage plus the in-memory decoded-image cache the renderer draws
 * from.
 *
 * Three responsibilities, deliberately in one module because they share the
 * key space:
 *
 * 1. **Content-addressed storage.** The key is a SHA-256 of the bytes, so the
 *    same image dropped ten times is stored once and decoded once. An id-based
 *    key would store ten copies and decode ten times, and the history stack
 *    would then hold ten distinct references to identical pixels.
 *
 * 2. **Ingest policy.** MIME allow-list, size cap, and downscaling to
 *    `MAX_IMAGE_DIMENSION` on the long edge before anything is written. A
 *    6000px photo on a 1200px canvas costs memory on every frame and buys no
 *    visible quality.
 *
 * 3. **A synchronous read for the renderer.** `resolveImage(key)` must not be
 *    async: it is called inside the draw loop, once per image element per
 *    frame, and a promise there would either stall the frame or restructure the
 *    renderer around suspense. It returns whatever is decoded *now* and starts
 *    a decode on a miss; the renderer paints a placeholder and repaints when
 *    the `subscribe` callback fires. That is the whole contract between this
 *    file and the engine.
 */

import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from '@/constants/defaults';
import { STORE_IMAGES } from '@/constants/storage';
import { defaultBackend, type StorageBackend, type StorageError, storageError } from './idb';
import { describeCause, err, ok, type Result } from './result';

export type ImageErrorKind =
  StorageError['kind'] | 'unsupported-type' | 'too-large' | 'decode-failed';

export interface ImageError {
  readonly kind: ImageErrorKind;
  readonly message: string;
}

export interface StoredImage {
  readonly key: string;
  /** Dimensions of the blob as stored - post-downscale, so this is what the element gets. */
  readonly width: number;
  readonly height: number;
}

/**
 * The raster operations, injected so the store is testable without a real
 * canvas. jsdom has no 2D context, so the default codec cannot run under test;
 * a stub codec lets the ingest *policy* (hashing, dedupe, limits) be tested
 * without pretending to test the browser's image decoder.
 */
export interface ImageCodec {
  measure(blob: Blob): Promise<{ width: number; height: number }>;
  /** Re-encode at the given size. `null` means "not possible here - store the original". */
  resize(blob: Blob, width: number, height: number): Promise<Blob | null>;
}

export interface ImageStore {
  storeImage(file: Blob): Promise<Result<StoredImage, ImageError>>;
  getImageBlob(key: string): Promise<Result<Blob | null, ImageError>>;
  putImageDataUri(key: string, dataUri: string): Promise<Result<void, ImageError>>;
  deleteImage(key: string): Promise<Result<void, ImageError>>;
  /** Synchronous, renderer-facing. See the module comment. */
  resolveImage(key: string): CanvasImageSource | null;
  /** Called with the key whose decode just finished, so the renderer can repaint. */
  subscribe(listener: (key: string) => void): () => void;
  clearCache(): void;
}

/* ---------------------------------------------------------------- hashing -- */

/**
 * `crypto.subtle` is only present in secure contexts. Plain http on a LAN
 * address is a real development scenario, so there is a fallback - a 64-bit
 * FNV-1a, tagged with a different key prefix so a weakly-hashed key can never
 * be mistaken for (or collide with) a strongly-hashed one for the same bytes.
 */
async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  // Annotated as possibly-undefined on purpose: the DOM lib declares
  // `crypto.subtle` as always present, but it is genuinely absent outside a
  // secure context, and without the annotation the guard below is dead code to
  // both the compiler and the linter.
  const subtle: SubtleCrypto | undefined =
    typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256-${hex}`;
  }
  return `fnv-${fnv1a64(bytes)}`;
}

function fnv1a64(bytes: Uint8Array): string {
  // Two 32-bit FNV-1a passes with different offset bases, concatenated. Not a
  // cryptographic hash and not claimed to be - it only needs to make an
  // accidental collision between two user images vanishingly unlikely.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------ browser codec -- */

/** GIFs are animated and SVGs are already resolution-independent; rasterising either loses more than it saves. */
const RESIZABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function browserCodec(): ImageCodec {
  return {
    measure: async (blob) => {
      if (typeof createImageBitmap !== 'function') {
        throw new Error('Image decoding is not available in this environment.');
      }
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    },
    resize: async (blob, width, height) => {
      if (!RESIZABLE_TYPES.has(blob.type) || typeof document === 'undefined') return null;
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((out) => {
          resolve(out);
        }, blob.type);
      });
    },
  };
}

/* ------------------------------------------------------------------ store -- */

function toImageError(error: StorageError): ImageError {
  return { kind: error.kind, message: error.message };
}

/** Scale factor that brings the long edge down to `MAX_IMAGE_DIMENSION`, or 1. */
function downscaleFactor(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  return longEdge > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longEdge : 1;
}

export interface ImageStoreOptions {
  readonly backend?: StorageBackend;
  readonly codec?: ImageCodec;
}

export function createImageStore(options: ImageStoreOptions = {}): ImageStore {
  const backend = options.backend ?? defaultBackend;
  const codec = options.codec ?? browserCodec();

  const decoded = new Map<string, HTMLImageElement>();
  const inFlight = new Set<string>();
  /** Keys whose decode failed. Kept so a miss doesn't retry forever, once per frame. */
  const failed = new Set<string>();
  const listeners = new Set<(key: string) => void>();

  function notify(key: string): void {
    for (const listener of listeners) listener(key);
  }

  async function readBlob(key: string): Promise<Result<Blob | null, ImageError>> {
    const read = await backend.get(STORE_IMAGES, key);
    if (!read.ok) return err(toImageError(read.error));
    return ok(read.value instanceof Blob ? read.value : null);
  }

  function startDecode(key: string): void {
    if (inFlight.has(key) || failed.has(key)) return;
    inFlight.add(key);

    void (async () => {
      try {
        const blob = await readBlob(key);
        if (!blob.ok || blob.value === null) throw new Error('image blob missing');
        const url = URL.createObjectURL(blob.value);
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => {
            resolve();
          };
          image.onerror = () => {
            reject(new Error('image failed to decode'));
          };
          image.src = url;
        });
        URL.revokeObjectURL(url);
        decoded.set(key, image);
      } catch {
        failed.add(key);
      } finally {
        inFlight.delete(key);
        // Notify on failure too - the renderer needs one repaint to swap the
        // "loading" placeholder for a "broken image" one.
        notify(key);
      }
    })();
  }

  return {
    storeImage: async (file) => {
      if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
        return err({
          kind: 'unsupported-type',
          message: `${file.type || 'This file'} is not a supported image type.`,
        });
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return err({
          kind: 'too-large',
          message: `Image is ${Math.round(file.size / 1024 / 1024)}MB; the limit is ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB.`,
        });
      }

      let blob = file;
      let width: number;
      let height: number;
      try {
        const measured = await codec.measure(blob);
        width = measured.width;
        height = measured.height;
        const factor = downscaleFactor(width, height);
        if (factor < 1) {
          const nextWidth = Math.max(1, Math.round(width * factor));
          const nextHeight = Math.max(1, Math.round(height * factor));
          const resized = await codec.resize(blob, nextWidth, nextHeight);
          if (resized) {
            blob = resized;
            width = nextWidth;
            height = nextHeight;
          }
        }
      } catch (cause) {
        return err({
          kind: 'decode-failed',
          message: `Could not read the image: ${describeCause(cause)}`,
        });
      }

      // Hashed *after* downscaling, so the key identifies the bytes actually
      // stored. Hashing the original would make two uploads of the same photo
      // at different source sizes look like different images.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const key = await hashBytes(bytes);

      const existing = await backend.get(STORE_IMAGES, key);
      if (existing.ok && existing.value instanceof Blob) return ok({ key, width, height });

      const written = await backend.put(STORE_IMAGES, key, blob);
      if (!written.ok) return err(toImageError(written.error));
      return ok({ key, width, height });
    },

    getImageBlob: readBlob,

    /** Used on import: an inlined data URI has to become a blob before it can be stored. */
    putImageDataUri: async (key, dataUri) => {
      const fetched = await fetch(dataUri).catch(() => null);
      if (!fetched) {
        return err({ kind: 'decode-failed', message: `Could not read inlined image "${key}".` });
      }
      const blob = await fetched.blob();
      const written = await backend.put(STORE_IMAGES, key, blob);
      return written.ok ? ok(undefined) : err(toImageError(written.error));
    },

    deleteImage: async (key) => {
      decoded.delete(key);
      failed.delete(key);
      const removed = await backend.delete(STORE_IMAGES, key);
      return removed.ok ? ok(undefined) : err(toImageError(removed.error));
    },

    resolveImage: (key) => {
      const image = decoded.get(key);
      if (image) return image;
      startDecode(key);
      return null;
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    clearCache: () => {
      decoded.clear();
      failed.clear();
    },
  };
}

export const imageStore: ImageStore = createImageStore();

/** Re-exported bare so the renderer can import the exact function it needs. */
export const resolveImage = (key: string): CanvasImageSource | null => imageStore.resolveImage(key);

/** Storage-level error for callers that need to construct one (e.g. degraded mode). */
export const unavailableImageError = (): ImageError =>
  toImageError(
    storageError('unavailable', 'Image storage is unavailable in this browser context.')
  );
