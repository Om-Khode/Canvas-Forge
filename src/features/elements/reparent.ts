/**
 * Moving one element between levels of the tree.
 *
 * Pure over `ElementStore`, like `group.ts` beside it: the slice owns *when*
 * this runs and history owns the undo entry, but who may move where - and the
 * one refusal that matters - is decidable from the document alone.
 *
 * **Two lists, one result.** A reparent removes an id from its old home and
 * inserts it into the new one, and those are separate arrays. Returning a
 * finished store rather than mutating in steps is what makes the pair
 * indivisible: the slice commits it once, so no undo entry can land on a
 * document where the element has left one list and not yet joined another.
 *
 * The *same* store comes back when the move would change nothing - refused,
 * unknown, or already there - which is what keeps a pointless drag out of the
 * undo stack rather than relying on history to notice afterwards.
 */

import { childIdsOf, isGroup, parentOf, wouldCreateCycle } from '@/features/elements/tree';
import type { CanvasElement, ElementId, ElementStore } from '@/types';

/**
 * Moves `id` into `parentId`'s child list - or into the root order, for `null`
 * - at `index`.
 *
 * `index` counts that list **as it currently stands**, bottom-to-top, with `id`
 * still in it if it is already there; anything past the end means the end. The
 * caller therefore does not have to know where the element currently sits,
 * which is the whole point: the layers panel resolves a pointer to a gap in the
 * list it can see, and this owns the pull-it-out-first correction.
 */
export function reparentElement(
  store: ElementStore,
  id: ElementId,
  parentId: ElementId | null,
  index: number
): ElementStore {
  if (store.byId[id] === undefined) return store;

  if (parentId !== null) {
    const parent = store.byId[parentId];
    // A leaf is not a container; nesting into one would strand the child
    // somewhere no walk can reach.
    if (parent === undefined || !isGroup(parent)) return store;
    /*
      Refused before anything is built, not repaired afterwards. A group inside
      its own descendant stops the tree being a tree: every walk in `tree.ts`
      would then be relying on its visited set to *terminate* rather than merely
      to avoid visiting twice, and the layers panel would list a subtree
      containing itself. `dropTarget.ts` declines to offer the drop as well, so
      the indicator and the document agree; this is the one that holds for every
      caller.
    */
    if (wouldCreateCycle(store, parentId, [id])) return store;
  }

  const from = parentOf(store, id);
  const source = listOf(store, from);
  const at = source.indexOf(id);
  const without = at === -1 ? source : [...source.slice(0, at), ...source.slice(at + 1)];

  if (from === parentId) {
    // Same list, so the slot the id is about to vacate has to be given back:
    // pulling it out first shifts everything above it down by one.
    const to = clampIndex(at !== -1 && index > at ? index - 1 : index, without.length);
    if (to === at) return store;
    const next = [...without];
    next.splice(to, 0, id);
    return withList(store, from, next);
  }

  const destination = listOf(store, parentId);
  const arrived = [...destination];
  arrived.splice(clampIndex(index, destination.length), 0, id);
  return withList(withList(store, from, without), parentId, arrived);
}

/** "Reorder layer" / "Move into group" - history labels are user-visible. */
export function reparentLabel(
  store: ElementStore,
  id: ElementId,
  parentId: ElementId | null
): string {
  if (parentOf(store, id) === parentId) return 'Reorder layer';
  return parentId === null ? 'Move out of group' : 'Move into group';
}

/** The sibling list an element lives in. `null` is the root order. */
function listOf(store: ElementStore, owner: ElementId | null): readonly ElementId[] {
  return owner === null ? store.order : childIdsOf(store, owner);
}

/**
 * The same document with that one list replaced.
 *
 * Every untouched element stays the same object, which is what history's
 * structural sharing rests on (docs/architecture.md#history) - and returning
 * the store itself for an unchanged root order keeps `byId` identical too, so
 * `tree.ts`'s parent index survives the write.
 */
function withList(
  store: ElementStore,
  owner: ElementId | null,
  list: readonly ElementId[]
): ElementStore {
  if (owner === null) {
    return list === store.order ? store : { byId: store.byId, order: list };
  }
  const group = store.byId[owner];
  if (group === undefined || !isGroup(group)) return store;
  const byId: Record<ElementId, CanvasElement> = {
    ...store.byId,
    [owner]: { ...group, childIds: list },
  };
  return { byId, order: store.order };
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}
