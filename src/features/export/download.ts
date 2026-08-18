/**
 * Triggering a file download from the browser.
 *
 * There is no API for "save this to the user's disk" short of the File System
 * Access API, which Safari and Firefox don't implement. The portable technique
 * is a synthetic `<a download>` click against an object URL.
 *
 * The subtlety is *when to revoke the URL*. Revoking immediately after
 * `click()` races the browser's fetch of the blob - Firefox in particular
 * starts the download asynchronously and ends up with an empty file. Revoking
 * never leaks the blob for the lifetime of the document, which for a 20MB PNG
 * export matters. So: revoke on a short timer, after the navigation has been
 * queued but soon enough that repeated exports don't accumulate.
 */

const REVOKE_DELAY_MS = 1000;

export interface DownloadError {
  readonly kind: 'unsupported';
  readonly message: string;
}

/** True when a download can actually be triggered (false during SSR / in tests). */
export function canDownload(): boolean {
  return typeof document !== 'undefined' && typeof URL.createObjectURL === 'function';
}

export function downloadBlob(blob: Blob, filename: string): DownloadError | null {
  if (!canDownload()) {
    return { kind: 'unsupported', message: 'Downloads are not available in this environment.' };
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // `rel="noopener"` because some browsers treat the synthetic click as a
  // navigation; the anchor is never attached to a visible layout.
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  // Appending is required by Firefox: a click on a detached element is ignored.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);

  return null;
}

export function downloadText(
  text: string,
  filename: string,
  mimeType: string
): DownloadError | null {
  // `charset=utf-8` matters: without it a project name with non-ASCII
  // characters is decoded as latin-1 by some editors.
  return downloadBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), filename);
}
