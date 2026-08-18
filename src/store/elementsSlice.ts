/**
 * The document slice.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. **Nothing is mutated.** An edit produces a new element object and a new
 *     `byId` map in which every *untouched* element is the same object
 *     reference as before. That is not a style preference - it is the entire
 *     basis of history's structural sharing (docs/architecture.md#history). A
 *     5,000-element document with one moved rectangle costs one map of pointers
 *     plus one element, not 5,000 clones.
 *
 *  2. **No action writes state directly.** Everything routes through
 *     `applyDocument` on the history slice, so there is no way to change the
 *     document without history observing it. A patch that changes nothing
 *     returns the *previous* document object, which history's reference-equality
 *     guard then recognises as a no-op and refuses to record.
 */

import { groupElements, ungroupElements } from '@/features/elements/group';
import type { ElementPatch, ElementPatchMap } from '@/features/elements/operations';
import { reparentElement, reparentLabel } from '@/features/elements/reparent';
import { descendantsOf } from '@/features/elements/tree';
import {
  bringForward as bringForwardOrder,
  bringToFront as bringToFrontOrder,
  moveToIndex as moveToIndexOrder,
  sendBackward as sendBackwardOrder,
  sendToBack as sendToBackOrder,
} from '@/features/elements/zorder';
import { withDerivedGroups } from '@/store/deriveGroups';
import { patchDocument } from '@/store/patchDocument';
import type { CanvasStore } from '@/store/index';
import type { CanvasElement, ElementId, ElementStore } from '@/types';
import type { StateCreator } from 'zustand';

export interface ElementsSlice {
  readonly elements: ElementStore;

  addElement: (element: CanvasElement, label?: string) => void;
  addElements: (elements: readonly CanvasElement[], label?: string) => void;

  updateElement: (id: ElementId, patch: ElementPatch, label?: string) => void;
  updateElements: (ids: Iterable<ElementId>, patch: ElementPatch, label?: string) => void;
  /** Per-element patches - the shape `features/elements/operations` and `features/alignment` return. */
  applyPatches: (patches: ElementPatchMap, label?: string) => void;

  removeElements: (ids: Iterable<ElementId>, label?: string) => void;

  /**
   * Collects the ids into a new group and returns its id, or `null` when they
   * cannot be grouped (fewer than two, or spread across different parents -
   * `features/elements/group.ts` owns that decision). The caller gets the id
   * back so it can select what it just made.
   */
  group: (ids: Iterable<ElementId>) => ElementId | null;
  /** Dissolves every group among `ids`. Non-groups are ignored. */
  ungroup: (ids: Iterable<ElementId>) => void;

  bringForward: (ids: Iterable<ElementId>) => void;
  sendBackward: (ids: Iterable<ElementId>) => void;
  bringToFront: (ids: Iterable<ElementId>) => void;
  sendToBack: (ids: Iterable<ElementId>) => void;
  moveToIndex: (id: ElementId, index: number) => void;
  /**
   * Moves one id into `parentId`'s child list - or into the root order, for
   * `null` - at `index`, counted bottom-to-top in that list *as it currently
   * stands*; anything past the end means the end. Refused when it would nest a
   * group inside its own descendant, and a no-op when nothing would move.
   *
   * Returns whether it actually committed, so a caller with a follow-up step
   * that only makes sense once the row has arrived - the layers panel
   * unfolding the group it was just dropped into - can order that step after
   * a write that is confirmed to have happened, rather than after a write
   * merely attempted.
   */
  reparent: (id: ElementId, parentId: ElementId | null, index: number) => boolean;

  setElementName: (id: ElementId, name: string) => void;
  toggleVisible: (id: ElementId) => void;
  toggleLocked: (id: ElementId) => void;

  /** Wholesale swap, used by project load. Clears history - see historySlice. */
  replaceDocument: (elements: ElementStore) => void;
}

export const EMPTY_ELEMENT_STORE: ElementStore = { byId: {}, order: [] };

/* ------------------------------------------------------------- selectors -- */

/**
 * `document.order` resolved to elements - **root ids only**, bottom-to-top.
 *
 * Not the renderer's paint order and not the layers panel's list: a root is
 * literally everything this walks, so any grouped content is invisible to it.
 * `elementsToPaint` (`features/elements/tree.ts`) is what the renderer and the
 * layers panel (via `layerRows.ts`) actually use, and every production call
 * site that once read this was migrated there or to `elementsInPaintOrder`
 * once grouping shipped. This one has no production caller left; it stays for
 * the perf benchmark that measures a flat `order` walk in isolation
 * (`docs/performance.md`) and for the test that pins this exact premise
 * (`ingest.test.ts`) rather than for anything that should read it as "the
 * document".
 */
export function elementsInOrder(document: ElementStore): CanvasElement[] {
  const out: CanvasElement[] = [];
  for (const id of document.order) {
    const element = document.byId[id];
    if (element !== undefined) out.push(element);
  }
  return out;
}

export function elementsByIds(document: ElementStore, ids: Iterable<ElementId>): CanvasElement[] {
  const out: CanvasElement[] = [];
  for (const id of ids) {
    const element = document.byId[id];
    if (element !== undefined) out.push(element);
  }
  return out;
}

export function selectSelectedElements(state: CanvasStore): CanvasElement[] {
  return elementsByIds(state.elements, state.selection);
}

/* ----------------------------------------------------------------- patch -- */

function withOrder(document: ElementStore, order: readonly ElementId[]): ElementStore {
  return order === document.order ? document : { byId: document.byId, order };
}

/**
 * Same content, ignoring which container objects happen to hold it: same
 * elements in the same order, and every id maps to the identical object on
 * both sides. Cheaper than deep equality and exact for this store's
 * invariant - an untouched element is never rebuilt (see the file docblock
 * above) - so a mismatch here always means something really changed, not that
 * two equal-looking elements were compared by value.
 *
 * `addElements` needs this because `withDerivedGroups` can hand back a document
 * that adds something and then, in the same pass, dissolves exactly that thing
 * - a pasted group every one of whose members failed validation, say - leaving
 * a result that is byte-for-byte what stood before the add, under a freshly
 * built `byId` and `order`. Reference equality alone would miss that and let a
 * paste that inserted nothing still cost an undo entry.
 */
function sameDocument(a: ElementStore, b: ElementStore): boolean {
  if (a === b) return true;
  if (a.order.length !== b.order.length) return false;
  for (let i = 0; i < a.order.length; i++) {
    if (a.order[i] !== b.order[i]) return false;
  }
  const aIds = Object.keys(a.byId);
  if (aIds.length !== Object.keys(b.byId).length) return false;
  for (const id of aIds) {
    if (a.byId[id] !== b.byId[id]) return false;
  }
  return true;
}

/** "3 elements" / "1 element" - history labels are user-visible. */
function countLabel(count: number): string {
  return count === 1 ? '1 element' : `${count} elements`;
}

/* ----------------------------------------------------------------- slice -- */

export const createElementsSlice: StateCreator<CanvasStore, [], [], ElementsSlice> = (
  _set,
  get
) => {
  /**
   * The one door out of this slice. Group geometry is re-derived here rather
   * than in the actions, so no action can produce a document that breaks the
   * invariants (see `deriveGroups.ts`); the pass returns its argument untouched
   * when there is nothing to fix, so a no-op edit stays a no-op to history.
   */
  const commit = (next: ElementStore, label: string): void => {
    const previous = get().elements;
    const derived = withDerivedGroups(next);
    // `derived` is only ever a different object from `next` when the document
    // has a group and something about it actually settled - the common,
    // group-free commit skips this entirely. When it does differ, the pass can
    // have added and then, in the very same pass, dissolved the only thing that
    // changed - a pasted group every member of which failed validation, say -
    // leaving content identical to `previous` under fresh containers.
    // `withDerivedGroups` has no way to notice that on its own: it only ever
    // settles against its own last iteration, never against the document the
    // whole commit started from. Settling against `previous` here is what keeps
    // that case a no-op the way every other pointless edit already is.
    get().applyDocument(
      derived !== next && sameDocument(derived, previous) ? previous : derived,
      label
    );
  };

  const patch = (patches: ElementPatchMap, label: string): void => {
    const document = get().elements;
    commit(patchDocument(document, patches), label);
  };

  const reorderWith = (
    operation: (order: readonly ElementId[], ids: Iterable<ElementId>) => readonly ElementId[],
    ids: Iterable<ElementId>,
    label: string
  ): void => {
    const document = get().elements;
    commit(withOrder(document, operation(document.order, ids)), label);
  };

  return {
    elements: EMPTY_ELEMENT_STORE,

    addElement: (element, label) => {
      get().addElements([element], label ?? `Add ${element.name}`);
    },

    addElements: (elements, label) => {
      if (elements.length === 0) return;
      const document = get().elements;
      const byId = { ...document.byId };
      for (const element of elements) byId[element.id] = element;
      commit(
        { byId, order: [...document.order, ...elements.map((element) => element.id)] },
        label ?? `Add ${countLabel(elements.length)}`
      );
    },

    updateElement: (id, elementPatch, label) => {
      patch({ [id]: elementPatch }, label ?? 'Edit element');
    },

    updateElements: (ids, elementPatch, label) => {
      const patches: Record<ElementId, ElementPatch> = {};
      let count = 0;
      for (const id of ids) {
        patches[id] = elementPatch;
        count++;
      }
      patch(patches, label ?? `Edit ${countLabel(count)}`);
    },

    applyPatches: (patches, label) => {
      patch(patches, label ?? `Edit ${countLabel(Object.keys(patches).length)}`);
    },

    removeElements: (ids, label) => {
      const document = get().elements;

      // The guard is on the map, not on the order: a group's members are not in
      // `order` at all, so "the order got shorter" would miss every delete
      // inside a group. Unknown ids are dropped here so a stale id from a panel
      // can't record an undo entry that deletes nothing.
      const requested = new Set<ElementId>();
      for (const id of ids) {
        if (document.byId[id] !== undefined) requested.add(id);
      }
      if (requested.size === 0) return;

      // Deleting a group deletes the subtree it owns. Leaving the members
      // behind would strand them in `byId` - unreachable from `order`, so
      // invisible and unselectable, yet still serialised into the project file.
      const doomed = new Set<ElementId>(requested);
      for (const id of requested) {
        for (const descendantId of descendantsOf(document, id)) doomed.add(descendantId);
      }

      const byId: Record<ElementId, CanvasElement> = {};
      for (const [id, element] of Object.entries(document.byId)) {
        if (!doomed.has(id)) byId[id] = element;
      }
      const order = document.order.filter((id) => !doomed.has(id));

      // Counted from what was asked for rather than from what went: deleting
      // one group is "Delete 1 element" however many members go with it.
      commit({ byId, order }, label ?? `Delete ${countLabel(requested.size)}`);
    },

    // One `commit` each, so a group or an ungroup - however many elements it
    // moves between levels - is one undo entry.
    group: (ids) => {
      const result = groupElements(get().elements, ids);
      if (result === null) return null;
      commit(result.store, 'Group');
      return result.groupId;
    },

    ungroup: (ids) => {
      commit(ungroupElements(get().elements, ids), 'Ungroup');
    },

    bringForward: (ids) => {
      reorderWith(bringForwardOrder, ids, 'Bring forward');
    },
    sendBackward: (ids) => {
      reorderWith(sendBackwardOrder, ids, 'Send backward');
    },
    bringToFront: (ids) => {
      reorderWith(bringToFrontOrder, ids, 'Bring to front');
    },
    sendToBack: (ids) => {
      reorderWith(sendToBackOrder, ids, 'Send to back');
    },
    moveToIndex: (id, index) => {
      const document = get().elements;
      commit(withOrder(document, moveToIndexOrder(document.order, id, index)), 'Reorder layer');
    },

    /**
     * Dragging a row in the layers panel onto, above, or below another one.
     *
     * Leaving the old home and joining the new one are one `commit`, so one
     * undo entry: a document that had done only half of it would be corrupt.
     * `reparentElement` hands back the same store for a move that is refused or
     * changes nothing, and no write is issued for that - history's
     * reference-equality guard would probably reach the same answer, but a
     * no-op by accident is not the same as one that was never attempted.
     */
    reparent: (id, parentId, index) => {
      const document = get().elements;
      const next = reparentElement(document, id, parentId, index);
      if (next === document) return false;
      commit(next, reparentLabel(document, id, parentId));
      return true;
    },

    setElementName: (id, name) => {
      patch({ [id]: { name } }, 'Rename element');
    },

    toggleVisible: (id) => {
      const element = get().elements.byId[id];
      if (element === undefined) return;
      patch(
        { [id]: { visible: !element.visible } },
        element.visible ? 'Hide element' : 'Show element'
      );
    },

    toggleLocked: (id) => {
      const element = get().elements.byId[id];
      if (element === undefined) return;
      patch(
        { [id]: { locked: !element.locked } },
        element.locked ? 'Unlock element' : 'Lock element'
      );
    },

    replaceDocument: (elements) => {
      // Same invariant as every other write: a loaded document can carry a
      // stale group box or an empty group (persistence deliberately keeps
      // `children: []` and relies on this to clean it up). Deriving here means
      // the fix-up happens before the first paint rather than on the first
      // edit, and - because `withDerivedGroups` returns its argument untouched
      // when nothing is wrong - a document with no groups keeps its identity,
      // which is what the "clears history when a project is loaded" test relies on.
      get().resetDocument(withDerivedGroups(elements));
    },
  };
};
