/**
 * Conversion between the in-memory `Project` and the serialized document.
 *
 * The two shapes differ deliberately.
 *
 * **In memory: `{ byId, order }`.** Hit-testing and selection resolve ids
 * constantly, so a map is O(1); reordering a layer rewrites a short array of
 * strings and leaves every element object reference intact, which is what makes
 * history's structural sharing work. Membership lives on each group's
 * `childIds`, and `order` names only the root.
 *
 * **On disk: a nested forest in paint order.** The original argument for a flat
 * array was that an array is self-describing and cannot disagree with itself,
 * while a map plus an order array can - an id in `order` with no entry in
 * `byId`, an entry missing from `order`, a duplicate in `order`. Groups turn
 * that argument around rather than weakening it: a flat array carrying
 * `childIds` *can* now disagree with itself, because an id listed inside a
 * group and again at the root describes two different trees and the loader
 * would have to pick one. Nesting cannot express that state at all - every
 * element is written exactly where it belongs, once. Same principle, opposite
 * conclusion, because the data changed. This supersedes the "elements is a flat
 * array in paint order" passage in `docs/data-model.md`.
 *
 * Images are inlined as data URIs in the serialized form *only when exporting*.
 * The IndexedDB record leaves `images` empty because the blobs live in their
 * own store, keyed by content - see `services/imageStore.ts`. Same schema, two
 * population strategies, which is exactly the storage-vs-portability trade in
 * docs/architecture.md §8.
 */

import { CURRENT_SCHEMA_VERSION } from '@/constants/storage';
import { elementsInPaintOrder, isGroup } from '@/features/elements/tree';
import { err, ok, type Result } from '@/services/result';
import type {
  CanvasElement,
  ElementId,
  ElementStore,
  Project,
  SerializedElement,
  SerializedProject,
} from '@/types';
import { migrateDocument, type MigrationChain, type MigrationError } from './migrations';
import { validateSerializedProject, type ValidationError } from './validate';

export type DeserializeError = MigrationError | ValidationError;

export interface DeserializedProject {
  readonly project: Project;
  /** Data URIs keyed by `ImageElement.imageKey`. Empty for documents loaded from IndexedDB. */
  readonly images: Readonly<Record<string, string>>;
  /** Notes about elements or images that were dropped, for the UI to surface. */
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------ write -- */

function toSerializedForest(
  store: ElementStore,
  ids: readonly ElementId[],
  visited: Set<ElementId>
): SerializedElement[] {
  const out: SerializedElement[] = [];
  for (const id of ids) {
    // The same guard the tree walks in `features/elements/tree.ts` carry, for
    // the same reason: `childIds` is data, so a store containing a cycle is a
    // store that can exist, and writing one has to terminate rather than
    // recurse until the stack dies.
    if (visited.has(id)) continue;
    visited.add(id);

    const element = store.byId[id];
    // An id with no element is a corrupt store. Skipping is the safe write -
    // the alternative is putting `undefined` into the elements array.
    if (element === undefined) continue;

    if (!isGroup(element)) {
      out.push(element);
      continue;
    }
    const { childIds, ...group } = element;
    out.push({ ...group, children: toSerializedForest(store, childIds, visited) });
  }
  return out;
}

/**
 * Nests a project into its serialized form.
 *
 * `images` is the data-URI map to inline; pass `{}` for the storage format.
 * Only keys actually referenced by an image element are carried over, so an
 * export never ships pixels for an image the user deleted - and the scan runs
 * over the whole forest, not just the root, or an image inside a group would
 * export without its pixels.
 */
export function serializeProject(
  project: Project,
  images: Readonly<Record<string, string>> = {}
): SerializedProject {
  const elements = toSerializedForest(project.elements, project.elements.order, new Set());

  const referenced: Record<string, string> = {};
  for (const element of elementsInPaintOrder(project.elements)) {
    if (element.type !== 'image') continue;
    const dataUri = images[element.imageKey];
    if (dataUri !== undefined) referenced[element.imageKey] = dataUri;
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: project.id,
    name: project.name,
    viewport: project.viewport,
    elements,
    metadata: project.metadata,
    images: referenced,
  };
}

/* ------------------------------------------------------------------- read -- */

/**
 * Rebuilds the normalized store from an already-validated document.
 *
 * Separate from `deserializeProject` so the repository can denormalize a
 * document it has already validated without paying for validation twice. It
 * assumes validation has run: the depth cap and the uniqueness check live
 * there, so this walk is bounded and every id it writes is its own.
 */
export function fromSerialized(serialized: SerializedProject): Project {
  const byId: Record<ElementId, CanvasElement> = {};

  const collect = (nodes: readonly SerializedElement[]): ElementId[] =>
    nodes.map((node) => {
      if (node.type === 'group') {
        const { children, ...group } = node;
        // Children first: `childIds` is the *result* of the descent, which is
        // what makes the store's parentage and the file's nesting the same
        // fact rather than two facts that have to be kept in agreement.
        byId[node.id] = { ...group, childIds: collect(children) };
      } else {
        byId[node.id] = node;
      }
      return node.id;
    });

  return {
    id: serialized.id,
    name: serialized.name,
    viewport: serialized.viewport,
    elements: { byId, order: collect(serialized.elements) },
    metadata: serialized.metadata,
  };
}

/**
 * The full load pipeline for an untrusted document: migrate, validate, then
 * denormalize. Ordering matters - migrations assume a well-formed old document
 * and validation assumes a current-schema one, so neither can absorb the
 * other's job.
 */
export function deserializeProject(
  input: unknown,
  chain?: MigrationChain
): Result<DeserializedProject, DeserializeError> {
  const migrated = chain ? migrateDocument(input, chain) : migrateDocument(input);
  if (!migrated.ok) return err(migrated.error);

  const validated = validateSerializedProject(migrated.value.doc);
  if (!validated.ok) return err(validated.error);

  const warnings = [...validated.value.warnings];
  if (migrated.value.applied.length > 0) {
    warnings.push(
      `Upgraded from schema ${migrated.value.fromVersion} to ${migrated.value.toVersion}.`
    );
  }

  return ok({
    project: fromSerialized(validated.value.project),
    images: validated.value.project.images,
    warnings,
  });
}
