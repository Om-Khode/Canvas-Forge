/**
 * What a canvas click actually selects.
 *
 * Hit-testing answers "which leaf is under the pointer". That is rarely what the
 * user means: clicking any member of a group selects the group, so a drag moves
 * the whole thing. Descending is explicit - double-click enters a group, and
 * from inside it a click selects one level down rather than the leaf.
 */

import {
  ancestorsOf,
  effectiveLocked,
  effectiveVisible,
  isGroup,
  leavesOf,
  parentOf,
} from '@/features/elements/tree';
import type { CanvasElement, ElementId, ElementStore } from '@/types';

export function resolveSelectionTarget(
  store: ElementStore,
  hitId: ElementId,
  enteredGroupId: ElementId | null
): ElementId {
  const ancestors = ancestorsOf(store, hitId);
  if (enteredGroupId === null) return ancestors[ancestors.length - 1] ?? hitId;

  const entered = ancestors.indexOf(enteredGroupId);
  // The click landed outside the entered group entirely; fall back to the
  // outermost, which is what leaving the group and clicking would have given.
  // This is also what keeps a stale `enteredGroupId` - one naming a group that
  // has since been ungrouped or deleted - from wedging selection: it is simply
  // not an ancestor of anything, so every click takes this branch.
  if (entered === -1) return ancestors[ancestors.length - 1] ?? hitId;
  // One level *inside* the entered group.
  return entered === 0 ? hitId : (ancestors[entered - 1] ?? hitId);
}

/**
 * `resolveSelectionTarget` over many hits, de-duplicated.
 *
 * This is the marquee's rule, and it is deliberately the same rule as a click's:
 * a rubber band that touches one member of a group selects the group, and every
 * other member it also touches collapses onto that same id rather than adding a
 * second entry. Anything else would mean dragging a box over a group and
 * getting a selection you could not have produced by clicking.
 */
export function resolveSelectionTargets(
  store: ElementStore,
  ids: Iterable<ElementId>,
  enteredGroupId: ElementId | null
): readonly ElementId[] {
  const seen = new Set<ElementId>();
  for (const id of ids) seen.add(resolveSelectionTarget(store, id, enteredGroupId));
  return [...seen];
}

/**
 * The group a double-click on `hitId` should descend into, or `null` when there
 * is nothing below the current level.
 *
 * Defined as "whatever a single click would have selected, if that is a group",
 * so the two gestures agree by construction: double-click enters the thing
 * click selects, and the click that follows resolves one level deeper.
 */
export function descendTarget(
  store: ElementStore,
  hitId: ElementId,
  enteredGroupId: ElementId | null
): ElementId | null {
  const target = resolveSelectionTarget(store, hitId, enteredGroupId);
  const element = store.byId[target];
  return element !== undefined && isGroup(element) ? target : null;
}

/**
 * The elements a transform should actually move.
 *
 * A group's box is a cache over its members, so writing to it moves nothing -
 * the leaves are the only things that hold real geometry.
 */
export function transformSet(
  store: ElementStore,
  ids: Iterable<ElementId>
): readonly CanvasElement[] {
  const out: CanvasElement[] = [];
  for (const id of leavesOf(store, ids)) {
    const element = store.byId[id];
    if (element !== undefined) out.push(element);
  }
  return out;
}

/**
 * Whether the pointer may pick an element, taking its ancestors into account.
 *
 * `engine/hitTest.isPickable` answers this for the element's own flags and
 * cannot do more - it is handed a flat array and has no view of the tree. But a
 * member of a hidden group is not on screen, and a member of a locked group is
 * opted out of pointer interaction, and neither fact is recorded on the member
 * itself. Passed into the hit test as a predicate rather than filtering the
 * array first so the walk still stops at the topmost hit.
 */
export function pointerEligibility(store: ElementStore): (element: CanvasElement) => boolean {
  return (element) => {
    // Almost every element is at the root with no ancestors to consult, and this
    // runs once per element per hit test - which is once per pointermove while
    // hovering. The two walks below each allocate; this lookup does not.
    if (parentOf(store, element.id) === null) return true;
    return effectiveVisible(store, element.id) && !effectiveLocked(store, element.id);
  };
}
