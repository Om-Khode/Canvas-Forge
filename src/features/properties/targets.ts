/**
 * Which elements a properties-panel *transform* reads, and the only ones it may
 * write to.
 *
 * Shared by the angle field (`features/properties/rotation`) and the position
 * and size fields (`features/properties/geometry`) because the rule is one rule,
 * not two that happen to agree today: both edit geometry, both have to expand a
 * group to its members, and both have to respect a lock that lives on a member
 * rather than on the thing that was selected. Two copies of that would drift the
 * first time the lock rule moves.
 *
 * A group contributes its leaves, **lock-filtered**: a lock inside a group is
 * what stops a group-level transform carrying that member along, and
 * `gestureTargets` is where that rule lives. A *directly selected* locked
 * element is kept on purpose - the panel has always edited locked elements,
 * which is how you work with one.
 *
 * No de-duplication: `withoutNestedIds` in `selectionSlice` guarantees no
 * selected id sits inside another selected group, so the leaf sets are disjoint.
 * A duplicate would be harmless anyway - every reader here keys by id.
 */

import { isGroup } from '@/features/elements/tree';
import { gestureTargets } from '@/features/selection/gestureTargets';
import type { CanvasElement, ElementId, ElementStore } from '@/types';

export function transformTargets(
  store: ElementStore,
  ids: Iterable<ElementId>
): readonly CanvasElement[] {
  const out: CanvasElement[] = [];
  for (const id of ids) {
    const element = store.byId[id];
    if (element === undefined) continue;
    if (isGroup(element)) out.push(...gestureTargets(store, [element.id]));
    else out.push(element);
  }
  return out;
}
