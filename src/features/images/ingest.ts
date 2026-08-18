/**
 * The image pipeline: file → validated → stored → `ImageElement` → document.
 *
 * `services/imageStore` already owns the *policy* (MIME allow-list, byte cap,
 * downscale to `MAX_IMAGE_DIMENSION`, content-hash dedupe) and returns a
 * `Result`. This module owns everything that policy cannot know about: how big
 * the element should be *on this canvas*, where it lands, and how a batch of
 * files becomes one undo entry. It deliberately re-uses the store's error type
 * rather than inventing a second vocabulary for the same failures.
 *
 * The element never holds pixels - only `imageKey`, the content hash. That is
 * what keeps a history snapshot a few hundred bytes per image instead of a few
 * megabytes (docs/architecture.md §8), and it is why nothing here reads the
 * blob back after storing it.
 *
 * Errors are values on the way in and a *reported string* on the way out: the
 * two entry points (a toolbar click and a drop) are both fire-and-forget from
 * the caller's point of view, so a failure has to reach the UI through a
 * channel of its own rather than as a rejected promise nobody awaits.
 */

import { ACCEPTED_IMAGE_TYPES, PASTE_OFFSET } from '@/constants';
import { createImage } from '@/features/elements/factory';
import { elementsInPaintOrder } from '@/features/elements/tree';
import { imageStore, type ImageError, type ImageStore } from '@/services/imageStore';
import { ok, type Result } from '@/services/result';
import { useCanvasStore, type ViewportSizePx } from '@/store';
import type { CanvasElement, ImageElement, Viewport, WorldPoint } from '@/types';
import { screenPoint, screenToWorld, worldPoint, worldRect } from '@/utils/coords';

/**
 * The largest fraction of the visible viewport a freshly-added image may cover.
 *
 * Without a cap a 4000px photo arrives at 4000 world units wide and fills the
 * screen - the user's first action is always to zoom out and scale it down.
 * Capping on the *viewport* rather than on a fixed world size means the image
 * looks the same size whatever zoom you dropped it at.
 *
 * Local to this module rather than in `src/constants/`: it describes this
 * feature's placement heuristic and has exactly one consumer. (The genuinely
 * shared image limits - dimension, byte cap, allow-list - already live in
 * `constants/defaults.ts`.)
 */
const MAX_VIEWPORT_FRACTION = 0.6;

/** Everything about the canvas that the sizing decision depends on. */
export interface ImagePlacement {
  readonly viewport: Viewport;
  readonly viewportSizePx: ViewportSizePx;
}

export interface IngestContext {
  readonly placement: ImagePlacement;
  /** The document's current elements - the auto-generated name is derived from them. */
  readonly existing?: readonly CanvasElement[];
  /** Injected so the ingest logic is testable against a memory backend. */
  readonly store?: ImageStore;
}

/* ----------------------------------------------------------------- sizing -- */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * World size for an image of `natural` pixels, capped to the viewport.
 *
 * One scale factor is applied to both axes, so the aspect ratio survives
 * exactly; scaling the axes independently is how an avatar ends up an oval.
 * A pixel maps to a world unit 1:1 below the cap, which means an image dropped
 * at 100% zoom appears at its true size - the least surprising default.
 */
export function fitImageSize(natural: ImageSize, placement: ImagePlacement): ImageSize {
  const width = Math.max(1, natural.width);
  const height = Math.max(1, natural.height);
  const { zoom } = placement.viewport;
  const { width: viewWidth, height: viewHeight } = placement.viewportSizePx;

  // A zero-sized viewport means the canvas has not been measured yet (first
  // paint, or a headless test). Capping against it would collapse the image to
  // nothing, so the cap is simply not applied.
  const maxWidth = viewWidth > 0 ? (viewWidth * MAX_VIEWPORT_FRACTION) / zoom : Infinity;
  const maxHeight = viewHeight > 0 ? (viewHeight * MAX_VIEWPORT_FRACTION) / zoom : Infinity;

  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

/* ---------------------------------------------------------------- ingest -- */

/** A `File` carries a name; a clipboard `Blob` does not. Used as the alt text. */
function describeFile(file: Blob): string {
  return file instanceof File ? file.name : '';
}

/**
 * Stores one file and builds the element for it, centred on `worldPointAt`.
 *
 * Centred rather than corner-anchored because both entry points hand us a point
 * the user aimed at - the drop position or the click - and "the thing lands
 * where I pointed" reads as centred, not as a top-left corner.
 */
export async function ingestImageFile(
  file: Blob,
  worldPointAt: WorldPoint,
  context: IngestContext
): Promise<Result<ImageElement, ImageError>> {
  const store = context.store ?? imageStore;
  const stored = await store.storeImage(file);
  // Failures are passed through untouched: `imageStore` already phrases them
  // for a human ("Image is 34MB; the limit is 20MB"), and re-wording them here
  // would give the same condition two different messages.
  if (!stored.ok) return stored;

  const size = fitImageSize(stored.value, context.placement);
  const box = worldRect(
    worldPointAt.x - size.width / 2,
    worldPointAt.y - size.height / 2,
    size.width,
    size.height
  );

  return ok(
    createImage(box, {
      imageKey: stored.value.key,
      naturalWidth: stored.value.width,
      naturalHeight: stored.value.height,
      alt: describeFile(file),
      existing: context.existing ?? [],
    })
  );
}

export interface IngestBatch {
  readonly elements: readonly ImageElement[];
  readonly errors: readonly ImageError[];
}

/**
 * Ingests a batch, cascading each element past the last.
 *
 * Sequential rather than `Promise.all`: each element's auto-generated name is
 * derived from the elements that already exist, so three images ingested in
 * parallel would all be told the document contains no images and all come back
 * named "Image 1".
 *
 * A file that fails does not abort the batch - dropping five photos where one
 * is a 40MB TIFF should add four images and explain the fifth.
 */
export async function ingestImageFiles(
  files: readonly Blob[],
  worldPointAt: WorldPoint,
  context: IngestContext
): Promise<IngestBatch> {
  const elements: ImageElement[] = [];
  const errors: ImageError[] = [];
  const existing = [...(context.existing ?? [])];

  for (const file of files) {
    // Cascade: a stack of identically-sized images dropped at one point looks
    // like a single image until you move it.
    const offset = PASTE_OFFSET * elements.length;
    const at = worldPoint(worldPointAt.x + offset, worldPointAt.y + offset);
    const result = await ingestImageFile(file, at, { ...context, existing });
    if (result.ok) {
      elements.push(result.value);
      existing.push(result.value);
    } else {
      errors.push(result.error);
    }
  }

  return { elements, errors };
}

/* ------------------------------------------------------------ the document -- */

/** The placement context for the canvas as it stands right now. */
export function currentPlacement(): ImagePlacement {
  const { viewport, viewportSize } = useCanvasStore.getState();
  return { viewport, viewportSizePx: viewportSize };
}

/** Where a paste or a keyboard-triggered upload lands: the middle of the view. */
export function viewportCenterWorldPoint(): WorldPoint {
  const { viewport, viewportSize } = useCanvasStore.getState();
  return screenToWorld(
    screenPoint(viewportSize.width / 2, viewportSize.height / 2),
    viewport
  );
}

/**
 * The whole journey for a set of files: ingest, add, select, report.
 *
 * `addElements` opens and commits an implicit transaction, so a five-file drop
 * is **one** undo entry rather than five. Selecting afterwards means the user
 * can immediately move or scale what they just added, which is what they were
 * about to do anyway.
 */
export async function insertImageFiles(
  files: readonly Blob[],
  worldPointAt: WorldPoint
): Promise<IngestBatch> {
  if (files.length === 0) return { elements: [], errors: [] };

  const batch = await ingestImageFiles(files, worldPointAt, {
    placement: currentPlacement(),
    // Every element at every depth, not just the roots: the auto-name is the
    // highest existing suffix plus one, so a walk that cannot see inside a
    // group would hand out an "Image 3" that already exists in one.
    existing: elementsInPaintOrder(useCanvasStore.getState().elements),
  });

  if (batch.elements.length > 0) {
    const label =
      batch.elements.length === 1 ? `Add ${batch.elements[0]?.name ?? 'image'}` : 'Add images';
    // Re-read: the document may have moved on while the decode was in flight.
    const store = useCanvasStore.getState();
    store.addElements(batch.elements, label);
    store.select(batch.elements.map((element) => element.id));
    // The image tool has done its job. Leaving it armed means the next click
    // anywhere on the canvas reopens the file dialog, which reads as the editor
    // being stuck rather than as a tool still being active.
    if (store.tool === 'image') store.setTool('select');
    // A banner left over from an earlier failure would now be describing
    // something that has since worked.
    if (batch.errors.length === 0) clearImageError();
  }
  if (batch.errors.length > 0) reportImageError(summarize(batch.errors));

  return batch;
}

function summarize(errors: readonly ImageError[]): string {
  const first = errors[0]?.message ?? 'That image could not be added.';
  return errors.length === 1 ? first : `${first} (${errors.length - 1} more failed.)`;
}

/* ------------------------------------------------------------ file picker -- */

export const IMAGE_FILE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(',');

/** Only the files this editor can actually store. */
export function imageFilesOf(files: Iterable<File>): readonly File[] {
  return [...files].filter((file) =>
    (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)
  );
}

/**
 * Opens the system file picker.
 *
 * A detached `<input type="file">` clicked programmatically, matching the JSON
 * import path - `showOpenFilePicker` is Chromium-only. The input is appended
 * before the click because Safari ignores a click on a detached node, and both
 * `change` and `cancel` remove it again so a dismissed dialog does not leak an
 * element into the DOM (and does not leave this promise pending forever).
 */
export function pickImageFiles(): Promise<readonly File[]> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve([]);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_FILE_ACCEPT;
    input.multiple = true;
    input.style.display = 'none';

    const settle = (files: readonly File[]): void => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => {
      settle(input.files === null ? [] : imageFilesOf(input.files));
    });
    input.addEventListener('cancel', () => {
      settle([]);
    });

    document.body.appendChild(input);
    input.click();
  });
}

/* ------------------------------------------------------- error reporting -- */

/**
 * One place the UI can watch for "that image did not work".
 *
 * A module-level channel rather than a store slice: the failure is transient
 * chrome, not document or view state, and the store's slices are a frozen
 * shared contract. `useSyncExternalStore` binds it to React in the
 * one component that renders it.
 */
let lastError: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function reportImageError(message: string): void {
  lastError = message;
  notify();
}

export function getImageError(): string | null {
  return lastError;
}

export function clearImageError(): void {
  if (lastError === null) return;
  lastError = null;
  notify();
}

export function subscribeImageError(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
