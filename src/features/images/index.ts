/**
 * Image ingestion. `ingest.ts` is the pipeline (store the blob, size the
 * element, add it to the document); `useImageDrop` is the DOM half that feeds
 * it from a drag, a paste, or a file picker.
 */

export {
  clearImageError,
  currentPlacement,
  fitImageSize,
  getImageError,
  imageFilesOf,
  IMAGE_FILE_ACCEPT,
  ingestImageFile,
  ingestImageFiles,
  insertImageFiles,
  pickImageFiles,
  reportImageError,
  subscribeImageError,
  viewportCenterWorldPoint,
  type ImagePlacement,
  type ImageSize,
  type IngestBatch,
  type IngestContext,
} from './ingest';

export { useImageDrop, type ImageDrop, type ImageDropHandlers } from './useImageDrop';
