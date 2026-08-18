/**
 * The command layer's public surface.
 *
 * Everything a user can do reaches the store through here: the table declares
 * the actions once, `useCommands` binds them to the keyboard, and the command
 * palette renders the same list. Components import from this module rather than
 * from the files inside it, so the internal split (table / clipboard / hook)
 * can change without touching the UI.
 */

export {
  applyPastedElements,
  createCommands,
  getExportFormat,
  setExportFormat,
  viewportCenterWorld,
  type CommandDeps,
  type ExportFormat,
  type ExportScope,
} from './createCommands';

export {
  buildPayload,
  clipboard,
  createClipboard,
  duplicateElements,
  parsePayload,
  placeForPaste,
  serializePayload,
  CLIPBOARD_KIND,
  CLIPBOARD_MIME,
  CLIPBOARD_VERSION,
  type Clipboard,
  type ClipboardOptions,
  type ClipboardPayload,
  type CopyContext,
  type PasteContext,
  type PasteResult,
  type SystemClipboard,
} from './clipboard';

export { commandRegistry, useCommands } from './useCommands';
