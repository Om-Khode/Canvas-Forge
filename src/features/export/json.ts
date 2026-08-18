/**
 * JSON export and import.
 *
 * Thin on purpose: the interesting work - flattening the store, running
 * migrations, validating untrusted input - already lives in
 * `features/project`. This file only adds the two things that are specific to
 * *files*: producing text, and turning arbitrary text back into a document
 * without ever throwing.
 *
 * Exported JSON inlines images as data URIs so the file is self-contained and
 * survives being emailed. That costs ~33% over the raw bytes and is the whole
 * reason the storage format and the export format differ (architecture §8).
 */

import {
  deserializeProject,
  serializeProject,
  type DeserializedProject,
  type DeserializeError,
} from '@/features/project/serialize';
import { err, ok, type Result } from '@/services/result';
import type { Project, SerializedProject } from '@/types';

export const JSON_EXPORT_MIME = 'application/json';
export const JSON_EXPORT_EXTENSION = '.canvasforge.json';

export type ImportError =
  DeserializeError | { readonly kind: 'malformed-json'; readonly message: string };

/** The document that will be written. Exposed so callers can inspect size before saving. */
export function buildJsonExport(
  project: Project,
  images: Readonly<Record<string, string>> = {}
): SerializedProject {
  return serializeProject(project, images);
}

/**
 * Two-space indentation rather than minified: an exported project is something
 * a developer might open, diff, or hand-edit, and the size difference is
 * rounding error next to the inlined images.
 */
export function toJsonString(document: SerializedProject): string {
  return JSON.stringify(document, null, 2);
}

export function exportProjectJson(
  project: Project,
  images: Readonly<Record<string, string>> = {}
): Result<string, { readonly kind: 'serialize-failed'; readonly message: string }> {
  try {
    return ok(toJsonString(buildJsonExport(project, images)));
  } catch (cause) {
    // `JSON.stringify` throws on cyclic structures and on BigInt. Neither is
    // reachable through the element model, but export is the last chance to
    // notice if that ever stops being true.
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'serialize-failed', message: `Could not encode the project: ${detail}` });
  }
}

/** Parses an imported file. Malformed JSON is a plain error, never an exception. */
export function importProjectJson(text: string): Result<DeserializedProject, ImportError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'malformed-json', message: `This file isn't valid JSON: ${detail}` });
  }
  return deserializeProject(parsed);
}

/**
 * Filename from a project name. Whitespace collapses to hyphens and anything
 * outside `[a-z0-9-_]` is dropped - filesystem-safe on every platform, and it
 * also strips path separators, which is what stops a project named `../../x`
 * from being a download-path escape.
 */
export function jsonFilename(projectName: string, extension = JSON_EXPORT_EXTENSION): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug.length > 0 ? slug : 'canvasforge-project'}${extension}`;
}
