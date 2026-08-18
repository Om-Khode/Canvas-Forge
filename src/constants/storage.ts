/** Persistence keys, schema version, and history limits. */

/**
 * Bumped whenever the serialized shape changes in a way older files can't be
 * read as-is. Every bump needs a matching entry in the migration chain -
 * see features/project/migrations.ts.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Deepest nesting accepted from a file. A hostile document can nest far enough
 * to overflow the stack on any recursive walk - validation, denormalization,
 * paint order, SVG export - so the cap is enforced at both places untrusted
 * input becomes a document: `validate.ts` on the load path, and
 * `projectRepository.ts`'s own raw walk. Anything past it is dropped and
 * reported rather than parsed. Clipboard paste is a third untrusted-input path
 * and does not enforce this cap yet - a known gap, see
 * `docs/decisions/006-grouping.md`.
 *
 * 64 is far beyond any structure a person builds by hand and far below the
 * engine's frame budget for a recursive walk.
 */
export const MAX_GROUP_DEPTH = 64;

export const DB_NAME = 'canvasforge';
export const DB_VERSION = 1;
export const STORE_PROJECTS = 'projects';
export const STORE_IMAGES = 'images';

/** localStorage keys. Namespaced so they can't collide with anything else on the origin. */
export const LS_THEME = 'canvasforge:theme';
export const LS_LAST_PROJECT = 'canvasforge:last-project';
export const LS_PANELS = 'canvasforge:panels';

/** Debounce between the last edit and an autosave write. */
export const AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * History depth. Snapshots share structure, so an entry costs one map of
 * pointers plus the elements that actually changed - but the cap still bounds
 * worst-case memory for documents with large freehand paths.
 */
export const HISTORY_LIMIT = 100;

export const PROJECT_NAME_MAX_LENGTH = 80;
export const DEFAULT_PROJECT_NAME = 'Untitled';
