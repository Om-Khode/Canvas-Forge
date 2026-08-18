/**
 * The command table - every user-invocable action in the editor, declared once.
 *
 * The toolbar, the keyboard, and the command palette all read this list, which
 * is the only way a shortcut and its palette entry cannot disagree. It is a
 * *factory* over its dependencies rather than a module-level constant so that
 * it is constructible against a fake store in a test, and so the store handle
 * it closes over is explicit rather than an ambient import.
 *
 * Two rules the table follows throughout:
 *
 * **State is read at invocation time, never captured.** Every `run` and every
 * `isEnabled` calls `store.getState()` afresh. Closing over a snapshot would
 * make a command registered at mount operate on the document as it was at
 * mount - the classic stale-closure bug, and an especially quiet one here
 * because the command would still appear to work.
 *
 * **`isEnabled` is honest.** The palette greys a command out from that signal
 * and the registry refuses its shortcut, so a predicate that lies is worse than
 * no predicate at all: "Undo" that looks available and does nothing teaches the
 * user that the whole palette is unreliable.
 */

import { MAX_ZOOM, MIN_ZOOM } from '@/constants';
import type { Clipboard, PasteResult } from '@/features/commands/clipboard';
import { duplicateElements } from '@/features/commands/clipboard';
import { canGroup } from '@/features/elements/group';
import { descendantsOf, elementsToPaint, subtreeLocked } from '@/features/elements/tree';
import type { ProjectSession } from '@/features/project/useProjectSession';
import { contentBounds } from '@/features/selection/bounds';
import type { Command } from '@/features/shortcuts/registry';
import {
  elementsByIds,
  selectCanRedo,
  selectCanUndo,
  selectEnteredGroupId,
  type CanvasStore,
  type PanelId,
} from '@/store';
import type { CanvasElement, ElementId, ToolId, Vec2 } from '@/types';
import { screenPoint, screenToWorld, toVec2 } from '@/utils/coords';
import type { StoreApi } from 'zustand';

export type ExportFormat = 'png' | 'svg' | 'json';
export type ExportScope = 'document' | 'selection';

export interface CommandDeps {
  readonly store: StoreApi<CanvasStore>;
  readonly clipboard: Clipboard;
  readonly session: ProjectSession;
  /** Opens the export dialog with a format preselected. */
  readonly openExport: (format: ExportFormat) => void;
  /** Opens a file picker and imports the chosen document. */
  readonly importJson: () => void;
  readonly toggleTheme: () => void;
  readonly isDarkTheme: () => boolean;
}

interface ToolSpec {
  readonly tool: ToolId;
  readonly title: string;
  readonly shortcut: string;
  readonly icon: string;
  readonly keywords: readonly string[];
}

/**
 * `V R O L A P T H` come from the spec; `I` is the one letter it omits, and it
 * is the obvious mnemonic for the ninth tool.
 */
const TOOLS: readonly ToolSpec[] = [
  {
    tool: 'select',
    title: 'Select tool',
    shortcut: 'v',
    icon: 'mouse-pointer-2',
    keywords: ['move', 'arrow', 'pointer'],
  },
  {
    tool: 'rectangle',
    title: 'Rectangle tool',
    shortcut: 'r',
    icon: 'square',
    keywords: ['box', 'square', 'shape'],
  },
  {
    tool: 'ellipse',
    title: 'Ellipse tool',
    shortcut: 'o',
    icon: 'circle',
    keywords: ['circle', 'oval', 'shape'],
  },
  {
    tool: 'line',
    title: 'Line tool',
    shortcut: 'l',
    icon: 'minus',
    keywords: ['stroke', 'segment'],
  },
  {
    tool: 'arrow',
    title: 'Arrow tool',
    shortcut: 'a',
    icon: 'move-up-right',
    keywords: ['connector', 'pointer'],
  },
  {
    tool: 'freehand',
    title: 'Pencil tool',
    shortcut: 'p',
    icon: 'pen-tool',
    keywords: ['draw', 'freehand', 'sketch'],
  },
  {
    tool: 'text',
    title: 'Text tool',
    shortcut: 't',
    icon: 'type',
    keywords: ['label', 'type', 'font'],
  },
  {
    tool: 'image',
    title: 'Image tool',
    shortcut: 'i',
    icon: 'image',
    keywords: ['photo', 'picture', 'upload'],
  },
  {
    tool: 'hand',
    title: 'Hand tool',
    shortcut: 'h',
    icon: 'hand',
    keywords: ['pan', 'scroll', 'grab'],
  },
];

interface ExportSpec {
  readonly format: ExportFormat;
  readonly title: string;
  readonly icon: string;
  readonly keywords: readonly string[];
}

const EXPORTS: readonly ExportSpec[] = [
  {
    format: 'png',
    title: 'Export PNG…',
    icon: 'image',
    keywords: ['png', 'image', 'raster', 'bitmap', 'download'],
  },
  {
    format: 'svg',
    title: 'Export SVG…',
    icon: 'file-code',
    keywords: ['svg', 'vector', 'download'],
  },
  {
    format: 'json',
    title: 'Export JSON…',
    icon: 'braces',
    keywords: ['json', 'file', 'backup', 'download'],
  },
];

interface PanelSpec {
  readonly panel: PanelId;
  readonly title: string;
  readonly shortcut?: string;
  readonly icon: string;
  readonly keywords: readonly string[];
}

const PANELS: readonly PanelSpec[] = [
  {
    panel: 'layers',
    title: 'Toggle layers panel',
    shortcut: 'mod+shift+l',
    icon: 'layers',
    keywords: ['panel', 'sidebar', 'z-order', 'outline'],
  },
  {
    panel: 'properties',
    title: 'Toggle properties panel',
    // Firefox binds Ctrl+Shift+P to a private window and will not release it.
    // Kept anyway: it is the conventional binding, and both the palette entry
    // and the toolbar button still work. Inventing an unfamiliar chord to dodge
    // one browser is the worse trade.
    shortcut: 'mod+shift+p',
    icon: 'sliders-horizontal',
    keywords: ['panel', 'sidebar', 'inspector', 'style'],
  },
  {
    panel: 'minimap',
    title: 'Toggle minimap',
    icon: 'map',
    keywords: ['overview', 'navigator', 'thumbnail'],
  },
];

function countLabel(count: number): string {
  return count === 1 ? '1 element' : `${count} elements`;
}

/**
 * Where a paste from another document lands: the centre of what the user is
 * currently looking at.
 *
 * Pointer-anchored paste would be nicer still, but converting a pointer
 * position into world space needs the canvas element's bounding rect, which the
 * canvas stage owns and this layer deliberately cannot reach. The viewport
 * centre is the deterministic answer and is what every editor falls back to
 * when the paste did not come from a click.
 */
export function viewportCenterWorld(store: StoreApi<CanvasStore>): Vec2 {
  const { viewport, viewportSize } = store.getState();
  return toVec2(
    screenToWorld(screenPoint(viewportSize.width / 2, viewportSize.height / 2), viewport)
  );
}

/**
 * The elements in a self-contained set that no group *in the same set* claims.
 *
 * Pasting a group brings its members along, and those members are neither what
 * the user counts ("Paste 1 element", not 5) nor what should end up selected -
 * a selection holding a group and its own children would report a size the user
 * cannot see. The set is already self-contained after `cloneElements`, so this
 * needs no store.
 */
function topLevelOf(elements: readonly CanvasElement[]): CanvasElement[] {
  const claimed = new Set<ElementId>();
  for (const element of elements) {
    if (element.type === 'group') for (const childId of element.childIds) claimed.add(childId);
  }
  return elements.filter((element) => !claimed.has(element.id));
}

/**
 * Adds freshly-cloned elements to the document and selects them.
 *
 * Exported because two entry points produce a `PasteResult` - the `mod+v`
 * command and the DOM `paste` event - and "what happens after a paste" must be
 * one implementation. Selecting the new elements is what makes a second paste,
 * a nudge, or a drag act on the copy rather than on the original.
 *
 * Every element goes into the document; only the top-level ones are counted and
 * selected. `addElements` appends them all to the root order, and the store's
 * one-home invariant then moves the members back inside their group.
 */
export function applyPastedElements(
  store: StoreApi<CanvasStore>,
  result: PasteResult | null,
  verb: string
): void {
  if (result === null || result.elements.length === 0) return;
  const roots = topLevelOf(result.elements);
  const current = store.getState();
  current.addElements(result.elements, `${verb} ${countLabel(roots.length)}`);
  current.select(roots.map((element): ElementId => element.id));
}

/* ------------------------------------------------------- export intent -- */

/**
 * Which format the export dialog should open on.
 *
 * A single module variable rather than a field in the ui slice because it is
 * transient dialog *intent*, not application state: it is written immediately
 * before `openDialog('export')` and read once, as the dialog opens. Putting it
 * in the store would broadcast it to every subscriber for no benefit, and it
 * needs no subscription of its own because the dialog re-reads it on each open.
 */
let exportFormat: ExportFormat = 'png';

export function getExportFormat(): ExportFormat {
  return exportFormat;
}

export function setExportFormat(format: ExportFormat): void {
  exportFormat = format;
}

/* ----------------------------------------------------------- the table -- */

export function createCommands(deps: CommandDeps): Command[] {
  const state = (): CanvasStore => deps.store.getState();

  const selectedElements = (): CanvasElement[] => {
    const current = state();
    return elementsByIds(current.elements, current.selection);
  };

  /**
   * Locked elements are selectable (so they can be unlocked) but not editable.
   *
   * `subtreeLocked` rather than the element's own flag: Cut and Delete are the
   * two commands that consume this, both hand ids to `removeElements`, and that
   * takes the entire subtree. A group is therefore exactly as deletable as its
   * contents. The other available rule - delete the *unlocked* remainder - was
   * rejected: it leaves a half-emptied group behind and makes Delete mean two
   * different things depending on what is inside the thing being deleted.
   * Refusing the group is the conservative reading of a lock, and the rest of a
   * mixed selection still goes, exactly as it does for a locked loose element.
   */
  const editable = (): CanvasElement[] => {
    const document = state().elements;
    return selectedElements().filter((element) => !subtreeLocked(document, element.id));
  };

  /**
   * The given elements plus everything inside them, group first.
   *
   * Copying, cutting or duplicating a group has to take its members with it: a
   * group is nothing but a membership list, so a copy without the members is a
   * copy of nothing. Group-before-members is deliberate - it is the order
   * `addElements` appends in, and the store resolves a contested membership in
   * favour of whichever group reaches the element first.
   */
  const withDescendants = (elements: readonly CanvasElement[]): CanvasElement[] => {
    const document = state().elements;
    const ids = new Set<ElementId>();
    for (const element of elements) {
      ids.add(element.id);
      for (const id of descendantsOf(document, element.id)) ids.add(id);
    }
    return elementsByIds(document, ids);
  };

  /**
   * What the canvas actually paints - its only consumer is "zoom to fit", and a
   * frame has to be around content. `elementsInOrder` would name root ids only,
   * so a grouped document would be framed by the groups' cached boxes, which
   * span their hidden members too.
   */
  const paintedElements = (): readonly CanvasElement[] => elementsToPaint(state().elements);

  const pasteContext = () => ({
    documentId: deps.session.getState().projectId,
    anchorWorld: viewportCenterWorld(deps.store),
  });

  const applyIncoming = (result: PasteResult | null, verb: string): void => {
    applyPastedElements(deps.store, result, verb);
  };

  const command = (spec: Command): Command => spec;

  return [
    /* ------------------------------------------------------------- file -- */
    command({
      id: 'project.new',
      title: 'New project',
      group: 'file',
      icon: 'file-plus',
      keywords: ['create', 'blank', 'document'],
      run: () => {
        void deps.session.newProject();
      },
    }),
    command({
      id: 'project.save',
      title: 'Save project',
      group: 'file',
      shortcut: 'mod+s',
      icon: 'save',
      keywords: ['store', 'persist', 'write'],
      run: () => {
        void deps.session.saveNow();
      },
    }),
    command({
      id: 'project.open',
      title: 'Open project…',
      group: 'file',
      shortcut: 'mod+o',
      icon: 'folder-open',
      keywords: ['load', 'switch', 'projects', 'manage'],
      run: () => {
        state().openDialog('projects');
      },
    }),
    command({
      id: 'project.rename',
      title: 'Rename project…',
      group: 'file',
      icon: 'pencil',
      keywords: ['title', 'name'],
      run: () => {
        state().openDialog('projects');
      },
    }),
    command({
      id: 'project.duplicate',
      title: 'Duplicate project',
      group: 'file',
      icon: 'copy',
      keywords: ['clone', 'fork', 'copy'],
      run: () => {
        void deps.session.duplicateProject();
      },
    }),
    command({
      id: 'project.demo',
      title: 'Open demo project',
      group: 'file',
      icon: 'sparkles',
      keywords: ['example', 'sample', 'welcome', 'tour'],
      run: () => {
        void deps.session.openDemo();
      },
    }),

    /* ----------------------------------------------------------- export -- */
    ...EXPORTS.map((spec) =>
      command({
        id: `export.${spec.format}`,
        title: spec.title,
        group: 'export',
        icon: spec.icon,
        keywords: spec.keywords,
        // JSON of an empty project is a legitimate file - an empty *image* is
        // not, so only the raster and vector exports require content.
        ...(spec.format === 'json' ? {} : { isEnabled: () => state().elements.order.length > 0 }),
        run: () => {
          deps.openExport(spec.format);
        },
      })
    ),
    command({
      id: 'import.json',
      title: 'Import JSON…',
      group: 'export',
      icon: 'upload',
      keywords: ['open', 'restore', 'load', 'file'],
      run: deps.importJson,
    }),

    /* ------------------------------------------------------------- edit -- */
    command({
      id: 'edit.undo',
      title: 'Undo',
      group: 'edit',
      shortcut: 'mod+z',
      icon: 'undo-2',
      keywords: ['revert', 'back', 'history'],
      isEnabled: () => selectCanUndo(state()),
      run: () => {
        state().undo();
      },
    }),
    command({
      id: 'edit.redo',
      title: 'Redo',
      group: 'edit',
      shortcut: 'mod+shift+z',
      icon: 'redo-2',
      keywords: ['forward', 'again', 'history'],
      isEnabled: () => selectCanRedo(state()),
      run: () => {
        state().redo();
      },
    }),
    command({
      id: 'edit.cut',
      title: 'Cut',
      group: 'edit',
      shortcut: 'mod+x',
      icon: 'scissors',
      keywords: ['clipboard', 'remove'],
      isEnabled: () => editable().length > 0,
      run: () => {
        const elements = editable();
        if (
          !deps.clipboard.copy({
            elements: withDescendants(elements),
            documentId: deps.session.getState().projectId,
          })
        )
          return;
        state().removeElements(
          elements.map((element) => element.id),
          `Cut ${countLabel(elements.length)}`
        );
      },
    }),
    command({
      id: 'edit.copy',
      title: 'Copy',
      group: 'edit',
      shortcut: 'mod+c',
      icon: 'copy',
      keywords: ['clipboard', 'duplicate'],
      isEnabled: () => state().selection.size > 0,
      run: () => {
        deps.clipboard.copy({
          elements: withDescendants(selectedElements()),
          documentId: deps.session.getState().projectId,
        });
      },
    }),
    command({
      id: 'edit.paste',
      title: 'Paste',
      group: 'edit',
      shortcut: 'mod+v',
      icon: 'clipboard-paste',
      keywords: ['clipboard', 'insert'],
      isEnabled: () => deps.clipboard.canPaste(),
      run: () => {
        const context = pasteContext();
        const immediate = deps.clipboard.paste(context);
        if (immediate !== null) {
          applyIncoming(immediate, 'Paste');
          return;
        }
        // Nothing local: fall through to the system clipboard. Async, and it may
        // prompt - which is acceptable precisely here, where the user has asked
        // for a paste and there is nothing else to serve it from.
        void deps.clipboard.pasteAsync(context).then((result) => {
          applyIncoming(result, 'Paste');
        });
      },
    }),
    command({
      id: 'edit.duplicate',
      title: 'Duplicate',
      group: 'edit',
      shortcut: 'mod+d',
      icon: 'copy-plus',
      keywords: ['clone', 'repeat'],
      isEnabled: () => state().selection.size > 0,
      run: () => {
        const cloned = duplicateElements(withDescendants(selectedElements()));
        if (cloned === null) return;
        applyIncoming({ ...cloned, source: 'internal' }, 'Duplicate');
      },
    }),
    command({
      id: 'edit.delete',
      title: 'Delete',
      group: 'edit',
      shortcut: 'delete',
      icon: 'trash-2',
      keywords: ['remove', 'erase', 'backspace'],
      isEnabled: () => editable().length > 0,
      run: () => {
        const elements = editable();
        state().removeElements(
          elements.map((element) => element.id),
          `Delete ${countLabel(elements.length)}`
        );
      },
    }),
    command({
      id: 'edit.group',
      title: 'Group selection',
      group: 'edit',
      shortcut: 'mod+g',
      icon: 'group',
      keywords: ['group', 'combine', 'merge'],
      // The action's own decision, not an approximation of it: two selected
      // elements in different groups cannot be grouped, and offering a command
      // that would quietly do nothing is the dishonest `isEnabled` this table
      // forbids. Locks are not consulted - grouping moves nothing on screen and
      // a locked member stays locked inside the group.
      isEnabled: () => canGroup(state().elements, state().selection),
      run: () => {
        const current = state();
        const groupId = current.group(current.selection);
        // Selecting the new group is what makes the next drag move all of it.
        if (groupId !== null) current.select([groupId]);
      },
    }),
    command({
      id: 'edit.ungroup',
      title: 'Ungroup selection',
      group: 'edit',
      shortcut: 'mod+shift+g',
      icon: 'ungroup',
      keywords: ['ungroup', 'split', 'break apart'],
      isEnabled: () => selectedElements().some((element) => element.type === 'group'),
      run: () => {
        const current = state();
        // Read before the ungroup, because after it the groups are gone and
        // there is nothing left to ask who used to be inside them.
        const freed = selectedElements().flatMap((element): readonly ElementId[] =>
          element.type === 'group' ? element.childIds : []
        );
        current.ungroup(current.selection);
        current.select(freed);
      },
    }),
    command({
      id: 'edit.select-all',
      title: 'Select all',
      group: 'edit',
      shortcut: 'mod+a',
      icon: 'box-select',
      keywords: ['everything', 'all'],
      isEnabled: () => state().elements.order.length > 0,
      run: () => {
        state().selectAll();
      },
    }),
    command({
      id: 'edit.clear-selection',
      title: 'Clear selection',
      group: 'edit',
      shortcut: 'escape',
      icon: 'x',
      keywords: ['deselect', 'none', 'escape', 'exit group'],
      // Guarded on three fronts, all of which are other owners of Escape: a
      // dialog closes, an in-flight drag aborts, and only an idle canvas with
      // something to clear gets it. Reporting "not enabled" is what lets the
      // registry decline the key so it reaches whoever should have it.
      //
      // Leaving an entered group rides on this command rather than on one of
      // its own: the registry throws on a duplicate chord, deliberately, so
      // Escape has exactly one owner and that owner has to do both jobs.
      isEnabled: () => {
        const current = state();
        return (
          current.activeDialog === null &&
          current.interaction.kind === 'idle' &&
          (current.selection.size > 0 || selectEnteredGroupId(current) !== null)
        );
      },
      run: () => {
        const current = state();
        current.clearSelection();
        current.enterGroup(null);
      },
    }),

    /* ------------------------------------------------------------ tools -- */
    ...TOOLS.map((spec) =>
      command({
        id: `tool.${spec.tool}`,
        title: spec.title,
        group: 'tools',
        shortcut: spec.shortcut,
        icon: spec.icon,
        keywords: spec.keywords,
        isActive: () => state().tool === spec.tool,
        run: () => {
          state().setTool(spec.tool);
        },
      })
    ),

    /* ------------------------------------------------------------- view -- */
    command({
      id: 'view.zoom-in',
      title: 'Zoom in',
      group: 'view',
      shortcut: 'mod+=',
      icon: 'zoom-in',
      keywords: ['magnify', 'closer', 'scale'],
      isEnabled: () => state().viewport.zoom < MAX_ZOOM,
      run: () => {
        state().zoomToStep('in');
      },
    }),
    command({
      id: 'view.zoom-out',
      title: 'Zoom out',
      group: 'view',
      shortcut: 'mod+-',
      icon: 'zoom-out',
      keywords: ['shrink', 'further', 'scale'],
      isEnabled: () => state().viewport.zoom > MIN_ZOOM,
      run: () => {
        state().zoomToStep('out');
      },
    }),
    command({
      id: 'view.zoom-fit',
      title: 'Zoom to fit',
      group: 'view',
      shortcut: 'mod+1',
      icon: 'maximize',
      keywords: ['frame', 'fit', 'all', 'content'],
      isEnabled: () => state().elements.order.length > 0,
      run: () => {
        const current = state();
        const bounds = contentBounds(paintedElements());
        if (bounds === null) current.resetView(current.viewportSize);
        else current.zoomToFit(bounds, current.viewportSize);
      },
    }),
    command({
      id: 'view.zoom-reset',
      title: 'Zoom to 100%',
      group: 'view',
      shortcut: 'mod+0',
      icon: 'scan',
      keywords: ['actual size', 'reset', '100'],
      isEnabled: () => state().viewport.zoom !== 1,
      run: () => {
        // Zoom about the viewport centre rather than `resetView`, which also
        // re-centres the world origin - that would teleport the camera away
        // from whatever the user was looking at.
        const current = state();
        const centre = screenPoint(current.viewportSize.width / 2, current.viewportSize.height / 2);
        current.zoomAtCursor(centre, 1 / current.viewport.zoom);
      },
    }),
    ...PANELS.map((spec) =>
      command({
        id: `view.toggle-${spec.panel}`,
        title: spec.title,
        group: 'view',
        ...(spec.shortcut === undefined ? {} : { shortcut: spec.shortcut }),
        icon: spec.icon,
        keywords: spec.keywords,
        isActive: () => state().panels[spec.panel],
        run: () => {
          state().togglePanel(spec.panel);
        },
      })
    ),

    /* ------------------------------------------------------ preferences -- */
    command({
      id: 'pref.toggle-theme',
      title: 'Toggle dark mode',
      group: 'preferences',
      icon: 'moon',
      keywords: ['theme', 'light', 'dark', 'appearance'],
      isActive: deps.isDarkTheme,
      run: deps.toggleTheme,
    }),
    command({
      id: 'palette.open',
      title: 'Open command palette',
      group: 'preferences',
      shortcut: 'mod+k',
      icon: 'command',
      keywords: ['commands', 'search', 'actions', 'menu'],
      // One of the few commands allowed to fire from inside a text field: it is
      // how a user who is mid-rename reaches everything else.
      allowWhileTyping: true,
      run: () => {
        state().openDialog('command-palette');
      },
    }),
  ];
}
