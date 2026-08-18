/**
 * Chrome state: which panels are open, which dialog is up, whether the project
 * is saved, and what it is called.
 *
 * **Theme is deliberately absent.** It is owned by the `useTheme` hook and the
 * `data-theme` attribute on the document element, read synchronously from
 * localStorage at boot. Routing it through this store would mean the first
 * paint happens before the store initialises - a visible flash of the wrong
 * theme - in exchange for nothing, since no other slice depends on it.
 */

import { DEFAULT_PROJECT_NAME, PROJECT_NAME_MAX_LENGTH } from '@/constants';
import type { CanvasStore } from '@/store/index';
import { ancestorsOf, isGroup } from '@/features/elements/tree';
import type { ElementId, SaveStatus } from '@/types';
import type { StateCreator } from 'zustand';

export type PanelId = 'properties' | 'layers' | 'minimap';

export type DialogId = 'export' | 'projects' | 'command-palette' | 'shortcuts';

export interface UiSlice {
  readonly panels: Readonly<Record<PanelId, boolean>>;
  /** At most one dialog at a time - a union, not a set of booleans. */
  readonly activeDialog: DialogId | null;
  readonly saveStatus: SaveStatus;
  readonly projectName: string;
  /**
   * Sticky aspect-ratio lock, ORed with the Shift key by the resize path.
   *
   * It lives here rather than in the properties panel's own state because the
   * canvas resize handles have to honour it too, and a toggle that only affects
   * the panel's W/H fields would be a control that appears to do one thing and
   * does half of it. Not in history - it is a preference about how the tool
   * behaves, not a fact about the document.
   */
  readonly lockAspect: boolean;
  /**
   * The group the user has descended into, if any. View state rather than
   * document state: on the element it would serialise into the file and make
   * entering a group undoable.
   *
   * Read through `selectEnteredGroupId`, not directly - the id can outlive the
   * group it names.
   */
  readonly enteredGroupId: ElementId | null;
  /**
   * Groups the layers panel is showing closed.
   *
   * View state for the same reason `enteredGroupId` is: on the element it would
   * serialise into the file and make folding a group away an undoable edit.
   *
   * Never pruned. An id here can name a group that has been ungrouped, deleted,
   * or undone out of existence, and that is harmless by construction - the row
   * builder only ever asks `collapsed.has(id)` about groups it is already
   * walking, so a stale id is inert rather than wedging. It also gets undo/redo
   * right for free: redo restores the same id, and the group comes back folded
   * exactly as the user left it.
   */
  readonly collapsedGroupIds: ReadonlySet<ElementId>;

  togglePanel: (panel: PanelId) => void;
  setPanelVisible: (panel: PanelId, visible: boolean) => void;
  openDialog: (dialog: DialogId) => void;
  closeDialog: () => void;
  setSaveStatus: (status: SaveStatus) => void;
  setProjectName: (name: string) => void;
  setLockAspect: (locked: boolean) => void;
  /** `null` returns to the top level. */
  enterGroup: (id: ElementId | null) => void;
  toggleGroupCollapsed: (id: ElementId) => void;
  /** Folds or unfolds one group. Unfolding is how a drop *into* one is made visible. */
  setGroupCollapsed: (id: ElementId, collapsed: boolean) => void;
  /** Unfolds whatever is hiding these ids, so each has a row to be shown in. */
  expandAncestorsOf: (ids: readonly ElementId[]) => void;
  /**
   * Drops every collapsed-group id. Called on project load, next to
   * `enterGroup(null)` - this is view state about the document that is being
   * replaced, and carrying it into the next one would leave the layers panel
   * folding groups the new document never named, growing the set for the rest
   * of the session.
   */
  clearCollapsedGroups: () => void;
}

const INITIAL_PANELS: Readonly<Record<PanelId, boolean>> = {
  properties: true,
  layers: true,
  minimap: false,
};

/** Shared so the initial state has one identity across every store reset. */
const NOTHING_COLLAPSED: ReadonlySet<ElementId> = new Set<ElementId>();

export const createUiSlice: StateCreator<CanvasStore, [], [], UiSlice> = (set, get) => ({
  panels: INITIAL_PANELS,
  activeDialog: null,
  // 'saved' rather than 'unsaved': an untouched new document has nothing to
  // write, and opening the editor to a "you have unsaved changes" indicator
  // trains the user to ignore it.
  saveStatus: 'saved',
  projectName: DEFAULT_PROJECT_NAME,
  lockAspect: false,
  enteredGroupId: null,
  collapsedGroupIds: NOTHING_COLLAPSED,

  setLockAspect: (locked) => {
    set({ lockAspect: locked });
  },

  enterGroup: (id) => {
    if (get().enteredGroupId === id) return;
    set({ enteredGroupId: id });
  },

  toggleGroupCollapsed: (id) => {
    get().setGroupCollapsed(id, !get().collapsedGroupIds.has(id));
  },

  setGroupCollapsed: (id, collapsed) => {
    const current = get().collapsedGroupIds;
    // Guarded like every other setter here: a new Set for an unchanged answer
    // is a reference change `selectLayerRows`'s memo would have to rebuild for.
    if (current.has(id) === collapsed) return;
    const next = new Set(current);
    if (collapsed) next.add(id);
    else next.delete(id);
    set({ collapsedGroupIds: next });
  },

  expandAncestorsOf: (ids) => {
    const store = get().elements;
    const next = new Set(get().collapsedGroupIds);
    let changed = false;
    for (const id of ids) {
      for (const ancestorId of ancestorsOf(store, id)) {
        if (next.delete(ancestorId)) changed = true;
      }
    }
    // Emitting a new Set when nothing was folded would invalidate the row
    // selector on every selection change, which is most of them.
    if (changed) set({ collapsedGroupIds: next });
  },

  clearCollapsedGroups: () => {
    // Guarded like every other setter here: emitting a new empty Set when the
    // one in place already is one would be a needless reference change for
    // `selectLayerRows`'s memo to notice.
    if (get().collapsedGroupIds.size === 0) return;
    set({ collapsedGroupIds: NOTHING_COLLAPSED });
  },

  togglePanel: (panel) => {
    const panels = get().panels;
    set({ panels: { ...panels, [panel]: !panels[panel] } });
  },

  setPanelVisible: (panel, visible) => {
    const panels = get().panels;
    if (panels[panel] === visible) return;
    set({ panels: { ...panels, [panel]: visible } });
  },

  openDialog: (dialog) => {
    set({ activeDialog: dialog });
  },

  closeDialog: () => {
    if (get().activeDialog === null) return;
    set({ activeDialog: null });
  },

  setSaveStatus: (status) => {
    if (get().saveStatus === status) return;
    set({ saveStatus: status });
  },

  setProjectName: (name) => {
    // Clamped here rather than at every call site: rename arrives from the
    // title field, the project manager dialog, and JSON import.
    const trimmed = name.slice(0, PROJECT_NAME_MAX_LENGTH);
    if (get().projectName === trimmed) return;
    set({ projectName: trimmed });
  },
});

/**
 * The entered group, or `null` if it no longer exists.
 *
 * Validated on read rather than cleared on write, because the ways a group can
 * stop existing are open-ended - ungroup, delete, delete of an ancestor, an undo
 * that removes the group it was created by - and a clean-up hook on each is a
 * list that will eventually miss one. Checking here is one lookup and cannot be
 * forgotten. It also gets undo/redo right for free: redoing a group restores the
 * same id, so stepping back into it does not have to be re-entered by hand.
 *
 * `resolveSelectionTarget` degrades safely on a stale id anyway; this keeps the
 * chrome from claiming the user is inside a group that is gone.
 */
export function selectEnteredGroupId(state: CanvasStore): ElementId | null {
  const id = state.enteredGroupId;
  if (id === null) return null;
  const element = state.elements.byId[id];
  return element !== undefined && isGroup(element) ? id : null;
}
