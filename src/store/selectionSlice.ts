/**
 * Selection lives in its own slice, as a `Set<ElementId>`.
 *
 * The alternative - `selected: boolean` on the element - makes every click a
 * document mutation: it enters history (Ctrl+Z would undo a click), marks the
 * project dirty, and gets serialized into the saved file. Selection is view
 * state *about* the document, not part of it.
 *
 * Consequences that follow from that choice, and are enforced here:
 *  - selection changes never call `applyDocument`, so they are invisible to
 *    history and to autosave;
 *  - a set of ids makes select-all, shift-click toggling, and multi-select
 *    math direct rather than a scan over every element.
 */

import { ancestorsOf, parentOf } from '@/features/elements/tree';
import type { CanvasStore } from '@/store/index';
import type { ElementId, ElementStore } from '@/types';
import type { StateCreator } from 'zustand';

export interface SelectionSlice {
  readonly selection: ReadonlySet<ElementId>;

  /** Replaces the selection. Hidden and unknown ids are dropped. */
  select: (ids: Iterable<ElementId>) => void;
  /** Shift-click: flips one id in or out. */
  toggle: (id: ElementId) => void;
  addToSelection: (ids: Iterable<ElementId>) => void;
  clearSelection: () => void;
  selectAll: () => void;
}

const EMPTY_SELECTION: ReadonlySet<ElementId> = new Set<ElementId>();

/**
 * You cannot select what you cannot see: a hidden element would show resize
 * handles floating over nothing, and a subsequent drag would move something
 * invisible. Locked elements *are* selectable - the layers panel needs a way to
 * select one in order to unlock it.
 */
function selectable(state: CanvasStore, id: ElementId): boolean {
  return state.elements.byId[id]?.visible === true;
}

/** Avoids emitting a new Set when the outcome is identical - panels subscribe to this. */
function sameMembers(a: ReadonlySet<ElementId>, b: ReadonlySet<ElementId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Selection holds no id that is a descendant of another id already in it.
 *
 * Resolution (`features/selection/resolve.ts`) means a click never *hands*
 * this slice such a pair, but resolution is not the only door: `toggle` can
 * add a group while one of its own members is still selected from before -
 * entering it, selecting the member, leaving without clearing, then
 * shift-selecting the group at the top level is one reachable route, and it
 * is exactly the kind of state Tasks 6-8 would each otherwise have to
 * independently rule out (a group's cached box unioned with a member already
 * inside it, a transform snapshot that visits the member twice, and so on).
 *
 * Enforced as a filter over the *result* rather than special-cased per
 * caller, so it holds regardless of which id was already there and which one
 * just arrived: whichever id has an ancestor also present is dropped. That
 * resolves both directions the same way -
 *  - adding an ancestor of an already-selected descendant supersedes it: the
 *    descendant is redundant once the group that contains it is selected;
 *  - adding a descendant of an already-selected ancestor is a no-op: the
 *    coarser selection already covers it, and replacing it with the finer one
 *    would silently narrow a selection nobody asked to narrow.
 *
 * `ancestorsOf` is cached per `store.byId` (see `features/elements/tree.ts`),
 * so this costs one cached lookup per element already on a hot path, not a
 * new tree walk.
 *
 * **Takes the document, not the store, because validity is a property of the
 * (selection, document) *pair*.** A selection that was legal a moment ago
 * becomes illegal when the document grows an ancestor relationship underneath
 * it - `reparent(a, g, 0)` with both `g` and `a` selected - and no selection
 * write happens on that path at all. `historySlice.run` therefore re-applies
 * this on every document change, so it must be callable with the *next*
 * document rather than whatever the store currently holds. Returns the input
 * Set untouched when nothing is nested, which is what keeps that re-application
 * free for subscribers.
 */
export function withoutNestedIds(
  document: ElementStore,
  ids: ReadonlySet<ElementId>
): ReadonlySet<ElementId> {
  let nested: Set<ElementId> | null = null;
  for (const id of ids) {
    // An id with no parent cannot be inside anything, and in an ungrouped
    // document that is every id: one Map lookup, where `ancestorsOf` below
    // allocates an array and a Set per call. This runs on every commit,
    // including every frame of a drag with everything selected.
    if (parentOf(document, id) === null) continue;
    if (!ancestorsOf(document, id).some((ancestorId) => ids.has(ancestorId))) continue;
    (nested ??= new Set()).add(id);
  }
  if (nested === null) return ids;
  const kept = new Set<ElementId>();
  for (const id of ids) {
    if (!nested.has(id)) kept.add(id);
  }
  return kept;
}

export const createSelectionSlice: StateCreator<CanvasStore, [], [], SelectionSlice> = (
  set,
  get
) => {
  const commit = (next: ReadonlySet<ElementId>): void => {
    const state = get();
    const pruned = withoutNestedIds(state.elements, next);
    if (sameMembers(state.selection, pruned)) return;
    set({ selection: pruned });
  };

  return {
    selection: EMPTY_SELECTION,

    select: (ids) => {
      const state = get();
      commit(new Set([...ids].filter((id) => selectable(state, id))));
    },

    toggle: (id) => {
      const state = get();
      const next = new Set(state.selection);
      if (next.has(id)) next.delete(id);
      else if (selectable(state, id)) next.add(id);
      commit(next);
    },

    addToSelection: (ids) => {
      const state = get();
      const next = new Set(state.selection);
      for (const id of ids) {
        if (selectable(state, id)) next.add(id);
      }
      commit(next);
    },

    clearSelection: () => {
      commit(EMPTY_SELECTION);
    },

    selectAll: () => {
      const state = get();
      commit(new Set(state.elements.order.filter((id) => selectable(state, id))));
    },
  };
};

export function selectHasSelection(state: CanvasStore): boolean {
  return state.selection.size > 0;
}
