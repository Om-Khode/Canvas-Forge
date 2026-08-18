/**
 * Group creation, grouping and ungrouping.
 *
 * Pure over `ElementStore`. The slice owns *when* these run and history owns the
 * undo entry, but everything interesting here - who counts as a member, where
 * the group lands in z-order, where the children go back to - is decidable from
 * the document alone, so it is tested without a store.
 *
 * Neither operation touches a member's geometry. A group holds no transform of
 * its own; its members keep the world coordinates they already had, and the
 * group's box is a cache the store derives from them (`store/deriveGroups.ts`).
 * That is what makes grouping and ungrouping invisible on screen, which is the
 * behaviour every editor has and the one users assume.
 */

import { nextElementName } from '@/features/elements/names';
import { ancestorsOf, childIdsOf, isGroup, parentOf } from '@/features/elements/tree';
import type { CanvasElement, ElementId, ElementStore, GroupElement } from '@/types';
import { createId } from '@/utils/id';

export function createGroup(
  childIds: readonly ElementId[],
  options?: { name?: string; existing?: readonly CanvasElement[] }
): GroupElement {
  return {
    id: createId(),
    type: 'group',
    name: options?.name ?? nextElementName('group', options?.existing ?? []),
    // Zeroed rather than guessed: the box is a cache the store derives from the
    // members, and a factory-invented value would be wrong for exactly one
    // render before being overwritten.
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    childIds,
  };
}

/* -------------------------------------------------------------- grouping -- */

/** What `groupElements` decided before it minted anything. */
export interface GroupPlan {
  /** The members' shared parent; `null` when they sit at the document root. */
  readonly parent: ElementId | null;
  /** The members in their existing relative order, bottom to top. */
  readonly members: readonly ElementId[];
  /** The index the group takes in the parent's sibling list once the members leave it. */
  readonly at: number;
}

/**
 * Works out what grouping these ids would mean, or `null` when it means
 * nothing.
 *
 * Separate from `groupElements` so the command's `isEnabled` can ask the same
 * question the action will answer. A predicate that says "yes" to a selection
 * the action then refuses is exactly the kind of lying `isEnabled` that
 * `createCommands` forbids, and the only way to avoid it is to share the
 * decision rather than approximate it.
 *
 * Two filters, in order:
 *
 *  - **Ids whose own ancestor is in the set are dropped.** Grouping a group
 *    together with one of its members describes nothing. It is also the only
 *    route by which grouping could nest a group inside its own descendant, so
 *    this filter is why no `wouldCreateCycle` check is needed below: the new
 *    group's id is fresh, and nothing in the document can already point at it.
 *  - **Siblings only.** Members spanning two parents would have to be moved
 *    between levels, which is reparenting, not grouping. Refused rather than
 *    silently reparented - the user asked for one thing and would get another.
 */
export function planGroup(store: ElementStore, ids: Iterable<ElementId>): GroupPlan | null {
  const requested = new Set(ids);
  const members = new Set<ElementId>();
  for (const id of requested) {
    if (store.byId[id] === undefined) continue;
    if (ancestorsOf(store, id).some((ancestorId) => requested.has(ancestorId))) continue;
    members.add(id);
  }
  if (members.size < 2) return null;

  let parent: ElementId | null | undefined;
  for (const id of members) {
    const own = parentOf(store, id);
    if (parent === undefined) parent = own;
    else if (parent !== own) return null;
  }
  // Unreachable - the loop above runs at least twice - but it is what proves to
  // the compiler that `parent` is settled, and it costs one comparison.
  if (parent === undefined) return null;

  const siblings = parent === null ? store.order : childIdsOf(store, parent);
  const ordered = siblings.filter((id) => members.has(id));
  const top = ordered[ordered.length - 1];
  // A member that its own parent does not list is a malformed document, not a
  // reachable state; refusing beats splicing against an index of -1.
  if (top === undefined || ordered.length !== members.size) return null;

  return {
    parent,
    members: ordered,
    // The group takes the slot of its topmost member. Every *other* member sits
    // below that slot and is about to leave the list, so the index shifts down
    // by exactly `ordered.length - 1`.
    at: siblings.indexOf(top) - (ordered.length - 1),
  };
}

export function canGroup(store: ElementStore, ids: Iterable<ElementId>): boolean {
  return planGroup(store, ids) !== null;
}

/**
 * Groups a set of ids, or returns `null` when they cannot be grouped.
 *
 * Structural sharing holds: the only new objects are the group itself and - when
 * the members were nested - the one parent whose child list changed. Every other
 * element in the returned store is the same object it was.
 */
export function groupElements(
  store: ElementStore,
  ids: Iterable<ElementId>
): { store: ElementStore; groupId: ElementId } | null {
  const plan = planGroup(store, ids);
  if (plan === null) return null;

  const group = createGroup(plan.members, { existing: Object.values(store.byId) });
  const members = new Set(plan.members);
  const siblings = plan.parent === null ? store.order : childIdsOf(store, plan.parent);
  const nextSiblings = siblings.filter((id) => !members.has(id));
  nextSiblings.splice(plan.at, 0, group.id);

  const byId: Record<ElementId, CanvasElement> = { ...store.byId, [group.id]: group };
  if (plan.parent === null) return { store: { byId, order: nextSiblings }, groupId: group.id };

  const parentElement = byId[plan.parent];
  if (parentElement === undefined || !isGroup(parentElement)) return null;
  byId[plan.parent] = { ...parentElement, childIds: nextSiblings };
  return { store: { byId, order: store.order }, groupId: group.id };
}

/**
 * Dissolves each group, splicing its members back where the group stood.
 *
 * Back *where it stood*, not on top: a group sitting between two other shapes
 * carries a z-position its members inherited, and dropping them at the front of
 * the stack would silently reorder the drawing the user had arranged.
 *
 * Ids that are not groups are skipped, so the whole selection can be passed in
 * and a mixed selection ungroups the groups in it. Returns the *same* store when
 * nothing in `ids` was a group, which is what keeps a pointless Ctrl+Shift+G out
 * of the undo stack.
 *
 * The loop rebuilds `byId` once per group found in `ids`, so ungrouping *k*
 * groups in an *n*-element document costs O(k·n) map copies rather than one.
 * Fine for a keystroke's worth of selection; worth revisiting if `k` ever comes
 * from something like select-all on a document made mostly of groups.
 */
export function ungroupElements(store: ElementStore, ids: Iterable<ElementId>): ElementStore {
  let next = store;
  for (const id of ids) {
    const element = next.byId[id];
    if (element === undefined || !isGroup(element)) continue;

    const parent = parentOf(next, id);
    const siblings = parent === null ? next.order : childIdsOf(next, parent);
    const at = siblings.indexOf(id);
    // A group missing from its own sibling list cannot be spliced in place; its
    // members are freed at the top rather than at index -1, which would drop the
    // last sibling and duplicate the rest.
    const cut = at === -1 ? siblings.length : at;
    const replaced = [...siblings.slice(0, cut), ...element.childIds, ...siblings.slice(cut + 1)];

    // Rebuilt without the group rather than spread-and-deleted: every surviving
    // element is still the same object, and the members in particular are
    // untouched, which is what keeps ungrouping free of any visible movement.
    const byId: Record<ElementId, CanvasElement> = {};
    for (const [key, value] of Object.entries(next.byId)) {
      if (key !== id) byId[key] = value;
    }

    if (parent === null) {
      next = { byId, order: replaced };
      continue;
    }
    const parentElement = byId[parent];
    if (parentElement === undefined || !isGroup(parentElement)) continue;
    byId[parent] = { ...parentElement, childIds: replaced };
    next = { byId, order: next.order };
  }
  return next;
}
