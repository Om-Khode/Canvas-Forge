/**
 * The editor's modal surfaces.
 *
 * All three are self-wired - they read `activeDialog` from the ui slice and
 * close themselves - so the shell mounts them once with no props and never has
 * to hold "which dialog is open" in component state. At most one is ever
 * visible, because the slice models that as a union rather than as three
 * booleans that can all be true at once.
 */

export { CommandPalette } from './CommandPalette';
export { ExportDialog } from './ExportDialog';
export { ProjectDialog } from './ProjectDialog';
