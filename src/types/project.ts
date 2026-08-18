/**
 * The project document - the unit that is saved, loaded, exported, and
 * versioned.
 */

import type { CanvasElement, ElementId, GroupElement } from './element';

/**
 * The camera. `zoom` is a scale factor (1 = 100%), `panX`/`panY` are the screen
 * offset of the world origin.
 *
 *   screen = world * zoom + pan
 *   world  = (screen - pan) / zoom
 */
export interface Viewport {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

/**
 * The document's element storage.
 *
 * Normalized: a map for O(1) lookup during hit-testing and selection, plus an
 * ordered array of ids for paint order. Reordering a layer then rewrites a
 * small array of strings and leaves every element object reference untouched -
 * which is precisely what lets history share structure between snapshots.
 */
export interface ElementStore {
  readonly byId: Readonly<Record<ElementId, CanvasElement>>;
  /** Root-level ids, bottom to top. Members of a group live on its `childIds`. */
  readonly order: readonly ElementId[];
}

/**
 * A group as it appears on disk: its members inline, not by reference.
 *
 * Kept as its own named type rather than inlined into `SerializedElement` so
 * the reader can narrow to it by name instead of by shape.
 */
export interface SerializedGroupElement extends Omit<GroupElement, 'childIds'> {
  readonly children: readonly SerializedElement[];
}

/**
 * The on-disk shape of an element.
 *
 * Nested rather than flat-plus-`childIds`, and that reverses the reasoning in
 * `serialize.ts` for a reason worth stating. The flat array was chosen because
 * an array cannot disagree with itself the way a map plus an order array can.
 * Add membership and it can: an id listed inside a group *and* at the root
 * describes two different trees, and the loader would have to pick one. Nesting
 * cannot express that state at all - an element is written exactly where it
 * belongs, once. The same principle that chose flat now chooses nested. It also
 * happens to mirror SVG's `<g>`, which is what the export already wants.
 */
export type SerializedElement = Exclude<CanvasElement, GroupElement> | SerializedGroupElement;

export interface ProjectMetadata {
  /** ISO 8601. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly viewport: Viewport;
  readonly elements: ElementStore;
  readonly metadata: ProjectMetadata;
}

/**
 * The on-disk / on-wire shape. Distinct from `Project` because the serialized
 * form carries a schema version and inlines image data, while the in-memory
 * form references blobs by key.
 */
export interface SerializedProject {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly viewport: Viewport;
  /** The element forest, bottom to top, groups carrying their members inline. */
  readonly elements: readonly SerializedElement[];
  readonly metadata: ProjectMetadata;
  /** Image blobs as data URIs, keyed by `ImageElement.imageKey`. */
  readonly images: Readonly<Record<string, string>>;
}

/** Row stored in IndexedDB. The blob table is separate. */
export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly elementCount: number;
}

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';
