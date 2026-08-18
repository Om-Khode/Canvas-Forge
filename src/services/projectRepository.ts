/**
 * Project CRUD on top of the storage backend.
 *
 * The repository owns two things the layers above should not have to think
 * about: the storage document shape (serialized, images *not* inlined - the
 * blobs live in their own store) and the lifetime of image blobs.
 *
 * **Image garbage collection.** Blobs are keyed by content hash and therefore
 * shared: the same photo in three projects is one blob. That makes deletion a
 * reachability question, not a per-project one. `deleteProject` removes the
 * record, then sweeps: every image key still referenced by any surviving
 * project is kept, everything else is deleted. A mark-and-sweep rather than a
 * refcount because a refcount has to be updated on every element add, delete,
 * undo, and redo - four places to get wrong, all of them silently leaking or,
 * worse, deleting a blob that is still on screen. The sweep is O(projects) and
 * runs once, on an explicit user action.
 */

import { DEFAULT_ZOOM } from '@/constants/canvas';
import {
  DEFAULT_PROJECT_NAME,
  MAX_GROUP_DEPTH,
  PROJECT_NAME_MAX_LENGTH,
  STORE_IMAGES,
  STORE_PROJECTS,
} from '@/constants/storage';
import { deserializeProject, serializeProject } from '@/features/project/serialize';
import type { Project, ProjectSummary } from '@/types';
import { createId } from '@/utils/id';
import {
  defaultBackend,
  type StorageBackend,
  type StorageError,
  type StorageErrorKind,
} from './idb';
import { err, ok, type Result } from './result';

export type RepositoryErrorKind = StorageErrorKind | 'not-found' | 'invalid';

export interface RepositoryError {
  readonly kind: RepositoryErrorKind;
  readonly message: string;
  readonly cause?: unknown;
}

export interface LoadedProject {
  readonly project: Project;
  readonly warnings: readonly string[];
}

export interface ProjectRepository {
  createProject(name?: string): Promise<Result<Project, RepositoryError>>;
  saveProject(project: Project): Promise<Result<ProjectSummary, RepositoryError>>;
  loadProject(id: string): Promise<Result<LoadedProject, RepositoryError>>;
  listProjects(): Promise<Result<readonly ProjectSummary[], RepositoryError>>;
  deleteProject(id: string): Promise<Result<void, RepositoryError>>;
  duplicateProject(id: string, name?: string): Promise<Result<Project, RepositoryError>>;
}

function toRepositoryError(error: StorageError): RepositoryError {
  return { kind: error.kind, message: error.message, cause: error.cause };
}

function trimName(name: string): string {
  const trimmed = name.trim();
  const usable = trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_NAME;
  return usable.slice(0, PROJECT_NAME_MAX_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Depth-first walk over a raw, unvalidated element forest - nested groups
 * carry their members under `children`, the same shape `validate.ts` walks,
 * but this path never validates: `summarize` and the image-blob sweep below
 * cannot afford to (see `summarize`'s doc comment). Bounded by
 * `MAX_GROUP_DEPTH` for the same reason validation is - this walk runs on
 * records validation has not touched yet, so an attacker-supplied document
 * that nests past the cap has to be stopped here too, not just on the load
 * path. `children` is never assumed to be an array, and every node is
 * visited regardless of whether it looks like a well-formed element, so a
 * garbage entry still counts as one element the way a flat `.length` always
 * did.
 */
function walkForest(nodes: unknown, depth: number, visit: (node: unknown) => void): void {
  if (!Array.isArray(nodes) || depth > MAX_GROUP_DEPTH) return;
  for (const node of nodes) {
    visit(node);
    if (isRecord(node) && node.type === 'group') walkForest(node.children, depth + 1, visit);
  }
}

/** Total element count in a raw forest, including everything nested inside a group. */
function countForestElements(nodes: unknown): number {
  let count = 0;
  walkForest(nodes, 1, () => {
    count += 1;
  });
  return count;
}

/**
 * Cheap projection for the project list. Deliberately does *not* run full
 * validation: the manager dialog shows a name, a date, and a count, and paying
 * to validate every element of every project to render a list would make the
 * dialog's cost scale with total document size rather than project count.
 */
function summarize(record: unknown): ProjectSummary | null {
  if (!isRecord(record)) return null;
  const { id, name, metadata, elements } = record;
  if (typeof id !== 'string' || id.length === 0) return null;
  const updatedAt =
    isRecord(metadata) && typeof metadata.updatedAt === 'string' ? metadata.updatedAt : '';
  return {
    id,
    name: typeof name === 'string' ? name : DEFAULT_PROJECT_NAME,
    updatedAt,
    elementCount: countForestElements(elements),
  };
}

/**
 * Every image key referenced anywhere in a raw stored project record - the
 * *mark* phase of `deleteProject`'s mark-and-sweep. Must see every image no
 * matter how deep it is nested inside a group, or a surviving project's
 * grouped images are swept out from under it the next time any project is
 * deleted.
 */
function referencedImageKeys(record: unknown, into: Set<string>): void {
  if (!isRecord(record)) return;
  walkForest(record.elements, 1, (node) => {
    if (isRecord(node) && node.type === 'image' && typeof node.imageKey === 'string') {
      into.add(node.imageKey);
    }
  });
}

export function emptyProject(name = DEFAULT_PROJECT_NAME): Project {
  const now = new Date().toISOString();
  return {
    id: createId(),
    name: trimName(name),
    // Pan of zero rather than a centred origin: the repository has no idea how
    // big the viewport is. The editor recentres on first mount.
    viewport: { panX: 0, panY: 0, zoom: DEFAULT_ZOOM },
    elements: { byId: {}, order: [] },
    metadata: { createdAt: now, updatedAt: now },
  };
}

export function createProjectRepository(
  backend: StorageBackend = defaultBackend
): ProjectRepository {
  async function writeProject(project: Project): Promise<Result<ProjectSummary, RepositoryError>> {
    // `updatedAt` is stamped here, at the moment the bytes are written, rather
    // than by the caller. A timestamp set when the edit happened would drift
    // from what is actually on disk if the write is debounced or retried, and
    // the project list sorts on this field.
    const stamped: Project = {
      ...project,
      name: trimName(project.name),
      metadata: { ...project.metadata, updatedAt: new Date().toISOString() },
    };
    // `images: {}` - blobs live in STORE_IMAGES, not inline. Inlining here
    // would duplicate every image into every history-adjacent save.
    const record = serializeProject(stamped, {});
    const written = await backend.put(STORE_PROJECTS, stamped.id, record);
    if (!written.ok) return err(toRepositoryError(written.error));
    return ok({
      id: stamped.id,
      name: stamped.name,
      updatedAt: stamped.metadata.updatedAt,
      // Not `.length`: `record.elements` is root-level only now that groups
      // nest their members, and the summary is meant to count the document,
      // not just its roots.
      elementCount: countForestElements(record.elements),
    });
  }

  async function readRecord(id: string): Promise<Result<unknown, RepositoryError>> {
    const read = await backend.get(STORE_PROJECTS, id);
    if (!read.ok) return err(toRepositoryError(read.error));
    if (read.value === undefined || read.value === null) {
      return err({ kind: 'not-found', message: `No project with id ${id}.` });
    }
    return ok(read.value);
  }

  return {
    createProject: async (name) => {
      const project = emptyProject(name ?? DEFAULT_PROJECT_NAME);
      const written = await writeProject(project);
      return written.ok ? ok(project) : err(written.error);
    },

    saveProject: (project) => writeProject(project),

    loadProject: async (id) => {
      const record = await readRecord(id);
      if (!record.ok) return record;

      const parsed = deserializeProject(record.value);
      if (!parsed.ok) return err({ kind: 'invalid', message: parsed.error.message });
      return ok({ project: parsed.value.project, warnings: parsed.value.warnings });
    },

    listProjects: async () => {
      const rows = await backend.getAll(STORE_PROJECTS);
      if (!rows.ok) return err(toRepositoryError(rows.error));

      const summaries: ProjectSummary[] = [];
      for (const row of rows.value) {
        const summary = summarize(row);
        // An unreadable row is skipped, not fatal: one corrupt record must not
        // make the project manager unopenable.
        if (summary) summaries.push(summary);
      }
      // String compare works because the timestamps are ISO 8601 - lexical
      // order is chronological order, so no Date parsing per comparison.
      summaries.sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
      );
      return ok(summaries);
    },

    deleteProject: async (id) => {
      const removed = await backend.delete(STORE_PROJECTS, id);
      if (!removed.ok) return err(toRepositoryError(removed.error));

      const survivors = await backend.getAll(STORE_PROJECTS);
      const imageKeys = await backend.getAllKeys(STORE_IMAGES);
      // The project is gone either way. A failed sweep leaks blobs, which costs
      // disk but nothing else, so it is not reported as a delete failure.
      if (!survivors.ok || !imageKeys.ok) return ok(undefined);

      const reachable = new Set<string>();
      for (const record of survivors.value) referencedImageKeys(record, reachable);

      for (const key of imageKeys.value) {
        if (!reachable.has(key)) await backend.delete(STORE_IMAGES, key);
      }
      return ok(undefined);
    },

    duplicateProject: async (id, name) => {
      const record = await readRecord(id);
      if (!record.ok) return record;

      const parsed = deserializeProject(record.value);
      if (!parsed.ok) return err({ kind: 'invalid', message: parsed.error.message });

      const now = new Date().toISOString();
      // Element ids are kept. They only have to be unique *within* a document,
      // and rewriting them would be churn for no benefit. Image keys are kept
      // too, so the copy shares blobs with the original - the sweep in
      // `deleteProject` is what makes that safe.
      const copy: Project = {
        ...parsed.value.project,
        id: createId(),
        name: trimName(name ?? `${parsed.value.project.name} copy`),
        metadata: { createdAt: now, updatedAt: now },
      };
      const written = await writeProject(copy);
      return written.ok ? ok(copy) : err(written.error);
    },
  };
}

/** The instance the app uses. Tests construct their own over a memory backend. */
export const projectRepository: ProjectRepository = createProjectRepository();
