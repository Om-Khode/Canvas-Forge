/**
 * What a pointer gesture is actually allowed to move.
 *
 * Two facts have to be applied before a drag, a resize or a rotate can pick its
 * elements, and neither one is readable off the selected element:
 *
 *  - **A group is not the thing that moves.** Its box is a cache derived from
 *    its leaves (`store/deriveGroups.ts`), so a patch naming the group is
 *    recomputed away inside the same synchronous write and the gesture appears
 *    to do nothing at all. `transformSet` expands the selection down to the
 *    leaves, which are the only elements holding real geometry.
 *  - **The lock is inherited.** A locked member of a group is not pickable on
 *    its own, but clicking an *unlocked* sibling resolves to the parent group -
 *    and expanding that selection to leaves would drag the locked member along
 *    with everything else. This is the only point on the transform path where
 *    that is caught, so without the filter a lock inside a group is decorative.
 *
 * Kept apart from `resolve.ts` because `transformSet` answers a structural
 * question ("which elements does this selection stand for") that the properties
 * panel and alignment also ask, while these two answer a policy question about
 * pointer gestures specifically - the panel deliberately still edits a locked
 * element, which is how you unlock or restyle one.
 *
 * Deliberately visibility-blind: a hidden-but-unlocked member still counts as a
 * gesture target, so it keeps moving with a visible sibling's group drag. See
 * `features/elements/tree.ts` `elementsToPaint` for the render-side lock
 * notion this does not agree with, and why.
 */

import { effectiveLocked } from '@/features/elements/tree';
import { transformSet } from '@/features/selection/resolve';
import type { CanvasElement, ElementId, ElementStore } from '@/types';

export function gestureTargets(
  store: ElementStore,
  ids: Iterable<ElementId>
): readonly CanvasElement[] {
  return transformSet(store, ids).filter((element) => !effectiveLocked(store, element.id));
}

/**
 * Whether a selection has nothing a gesture could move.
 *
 * Empty selections are not "locked" - there is nothing to protect, and
 * reporting true would block the handle path for a state that has no handles.
 */
export function isGestureLocked(store: ElementStore, ids: ReadonlySet<ElementId>): boolean {
  return ids.size > 0 && gestureTargets(store, ids).length === 0;
}
