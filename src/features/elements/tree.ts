/**
 * Tree walks over the element store.
 *
 * Membership lives on the group as `childIds`, so "who is my parent" has no
 * direct answer - it is a reverse lookup. Building that index per call would
 * make hit-testing quadratic, so it is cached against `store.byId`.
 *
 * That key is exactly right, and for a narrower reason than "mutations replace
 * `byId`" - `withOrder` in the store deliberately does *not*, so a reorder keeps
 * the same `byId` and the same cached index. It doesn't need a new one:
 * `childIds` lives inside the element objects, so every mutation that can change
 * parentage replaces `byId`, and every mutation that leaves `byId` alone cannot
 * have changed parentage. The cache invalidates itself and there is no
 * invalidation to forget.
 */

import { elementBounds } from '@/features/selection/bounds';
import type { CanvasElement, ElementId, ElementStore, GroupElement, Rect } from '@/types';
import { unionRects } from '@/utils/geometry';

export function isGroup(element: CanvasElement): element is GroupElement {
  return element.type === 'group';
}

export function childIdsOf(store: ElementStore, id: ElementId): readonly ElementId[] {
  const element = store.byId[id];
  return element !== undefined && isGroup(element) ? element.childIds : [];
}

const parentIndexCache = new WeakMap<object, ReadonlyMap<ElementId, ElementId>>();

function parentIndex(store: ElementStore): ReadonlyMap<ElementId, ElementId> {
  const cached = parentIndexCache.get(store.byId);
  if (cached !== undefined) return cached;

  const index = new Map<ElementId, ElementId>();
  for (const element of Object.values(store.byId)) {
    if (!isGroup(element)) continue;
    for (const childId of element.childIds) index.set(childId, element.id);
  }
  parentIndexCache.set(store.byId, index);
  return index;
}

export function parentOf(store: ElementStore, id: ElementId): ElementId | null {
  return parentIndex(store).get(id) ?? null;
}

/**
 * Depth-first walk over `childIds`, visiting each id at most once.
 *
 * The visited set is not an optimisation, it is the crash guard. `childIds` is
 * data: it survives a round trip through a project file, so a group that lists
 * itself - or two groups that list each other - is a document that can exist,
 * and every walk below would otherwise recurse until the stack died. That is the
 * difference between the malformed-element rule being followed and being
 * asserted. `wouldCreateCycle` makes it sharper still: it is built on
 * `descendantsOf`, so without this the cycle *detector* would be the first thing
 * to fall over on a store that already contains one.
 *
 * `visit` receives the id whether or not it resolves, because a childId
 * referencing an element that isn't in `byId` is still a membership fact -
 * `descendantsOf` has to report it or `wouldCreateCycle` would miss the cycle
 * that runs through it.
 */
function walkChildren(
  store: ElementStore,
  rootIds: readonly ElementId[],
  visit: (id: ElementId, element: CanvasElement | undefined, depth: number) => void,
  visited: Set<ElementId> = new Set()
): void {
  const walk = (ids: readonly ElementId[], depth: number): void => {
    for (const id of ids) {
      if (visited.has(id)) continue;
      visited.add(id);
      const element = store.byId[id];
      visit(id, element, depth);
      if (element !== undefined && isGroup(element)) walk(element.childIds, depth + 1);
    }
  };
  walk(rootIds, 1);
}

export function ancestorsOf(store: ElementStore, id: ElementId): readonly ElementId[] {
  const index = parentIndex(store);
  const out: ElementId[] = [];
  // The upward equivalent of `walkChildren`'s visited set, and needed for the
  // same reason - a cycle in `childIds` is a cycle in the parent index too.
  const seen = new Set<ElementId>([id]);
  let current = index.get(id);
  while (current !== undefined && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = index.get(current);
  }
  return out;
}

export function outermostAncestor(store: ElementStore, id: ElementId): ElementId {
  const ancestors = ancestorsOf(store, id);
  return ancestors[ancestors.length - 1] ?? id;
}

export function descendantsOf(store: ElementStore, id: ElementId): readonly ElementId[] {
  const out: ElementId[] = [];
  // Seeded with `id` so a child pointing back at the root is dropped rather than
  // reported as its own descendant.
  walkChildren(store, childIdsOf(store, id), (childId) => out.push(childId), new Set([id]));
  return out;
}

export function leavesOf(store: ElementStore, ids: Iterable<ElementId>): readonly ElementId[] {
  const out: ElementId[] = [];
  // One set across the whole call, so an element named both directly and via a
  // group it belongs to is emitted once.
  walkChildren(store, [...ids], (id, element) => {
    if (element === undefined || isGroup(element)) return;
    out.push(id);
  });
  return out;
}

export function elementsInPaintOrder(store: ElementStore): readonly CanvasElement[] {
  const out: CanvasElement[] = [];
  walkChildren(store, store.order, (_id, element) => {
    if (element !== undefined) out.push(element);
  });
  return out;
}

/**
 * The flat, bottom-to-top array a frame is painted from.
 *
 * `elementsInPaintOrder` answers "what is in the document". This answers "what
 * does the engine need to see", and the whole difference is facts that live on
 * an *ancestor*. `RenderScene.elements` is a flat array by contract - the
 * renderer and the overlay hold no store handle and cannot consult the tree -
 * so three inherited things are resolved into each element here instead:
 *
 *  - a subtree under a hidden group is dropped, because `visible` on a member
 *    says nothing about the group above it. **Deliberate, undisclosed-until-
 *    now consequence (review round-1 finding 5):** a selected element loses
 *    its overlay frame the moment it is hidden, because the overlay finds the
 *    selected element by scanning this array and a hidden one is not in it -
 *    where `elementsInOrder` would have kept a root element there regardless.
 *    Kept rather than special-cased: an invisible element does not need a
 *    visible frame, and restoring one would mean painting chrome for content
 *    that draws nothing, which is a stranger rule than "hidden means gone.";
 *  - each ancestor's opacity is multiplied into the member's own, which is
 *    exactly what a `save` / `globalAlpha *=` / `restore` around the subtree
 *    would have produced - and is why `Renderer.drawOne` has always multiplied
 *    into the inherited alpha rather than assigning over it;
 *  - `locked` is rewritten to mean "no gesture can transform this", so the
 *    overlay stops drawing resize handles on a group whose members are all
 *    locked. The overlay draws its chrome from this same array.
 *
 * Groups stay in the array even though their drawer paints nothing: the overlay
 * finds the selected element by scanning it, so a selected group missing from
 * it would lose its selection frame.
 *
 * **This `locked` rewrite and `gestureTargets`' `effectiveLocked` (review
 * round-1 finding 3) answer different questions and are allowed to disagree.**
 * This one asks "is anything under here still paintable-as-movable", which is
 * visibility-blind by construction - a hidden-but-unlocked group is rewritten
 * `locked: true` here purely because nothing under it painted, not because a
 * gesture is refused. `gestureTargets` asks "may a drag actually move this",
 * which only reads the lock flag; visibility is a *pick* concern already
 * handled by `pointerEligibility` in `resolve.ts` - a hidden leaf cannot be hit
 * to start a drag in the first place. The gap this leaves is narrow (a group
 * selected before every member was hidden could, in principle, still resize
 * through a handle position the overlay no longer draws) and is left open
 * rather than folding visibility into `effectiveLocked`: a translate already
 * relies on a hidden-but-unlocked member moving *with* a visible sibling's
 * group drag - the ordinary "hide a layer, keep nudging its group" case -
 * and that would stop working the moment hidden also meant un-draggable.
 */
export function elementsToPaint(store: ElementStore): readonly CanvasElement[] {
  const out: CanvasElement[] = [];
  // The same crash guard `walkChildren` carries, for the same reason: `childIds`
  // is data that survives a round trip through a project file, so a cycle is a
  // document that can exist.
  const visited = new Set<ElementId>();

  /** Returns whether anything under `ids` is still transformable. */
  const walk = (ids: readonly ElementId[], alpha: number, lockedAbove: boolean): boolean => {
    let anyMovable = false;

    for (const id of ids) {
      if (visited.has(id)) continue;
      visited.add(id);

      const element = store.byId[id];
      if (element === undefined || !element.visible) continue;

      const locked = lockedAbove || element.locked;
      const opacity = alpha * clamp01(element.opacity);

      if (isGroup(element)) {
        // Pushed before the descent so paint order is untouched, then rewritten
        // once the walk knows whether anything inside it can still be moved -
        // which is not knowable until after the descent.
        const slot = out.length;
        out.push(element);
        const movable = walk(element.childIds, opacity, locked);
        if (movable) anyMovable = true;
        else out[slot] = { ...element, locked: true };
        continue;
      }

      out.push(withInherited(element, opacity, locked));
      if (!locked) anyMovable = true;
    }

    return anyMovable;
  };

  walk(store.order, 1, false);
  return out;
}

/**
 * Returns the element itself when nothing was inherited, which is the case for
 * every element of an ungrouped document - the copy is only paid for where a
 * group actually changed something.
 */
function withInherited(
  element: CanvasElement,
  opacity: number,
  locked: boolean
): CanvasElement {
  if (opacity === element.opacity && locked === element.locked) return element;
  return { ...element, opacity, locked };
}

/**
 * Opacity arrives from JSON and from numeric inputs; neither is trustworthy,
 * and a `NaN` multiplied down a subtree would silently blank every element
 * under it. `Renderer.drawOne` clamps again on the way to `globalAlpha` - the
 * two guards protect different things: this one protects the *product*.
 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function wouldCreateCycle(
  store: ElementStore,
  parentId: ElementId,
  childIds: Iterable<ElementId>
): boolean {
  for (const childId of childIds) {
    if (childId === parentId) return true;
    if (descendantsOf(store, childId).includes(parentId)) return true;
  }
  return false;
}

export function deriveGroupRect(store: ElementStore, groupId: ElementId): Rect | null {
  const boxes: Rect[] = [];
  for (const id of descendantsOf(store, groupId)) {
    const element = store.byId[id];
    // A nested group contributes nothing of its own; its members are already in
    // this list, so counting its cached box too would double-weight them.
    if (element === undefined || isGroup(element)) continue;
    boxes.push(elementBounds(element));
  }
  return unionRects(boxes);
}

export function effectiveLocked(store: ElementStore, id: ElementId): boolean {
  if (store.byId[id]?.locked === true) return true;
  return ancestorsOf(store, id).some((ancestorId) => store.byId[ancestorId]?.locked === true);
}

/**
 * Whether a lock anywhere on `id`'s path - above it *or* below it - should stop
 * an edit that takes the whole subtree.
 *
 * `effectiveLocked` only looks up, which is the right question for a transform:
 * moving a group moves its leaves, and a locked leaf is filtered out
 * individually by `gestureTargets`. Deletion has no such per-leaf escape -
 * `removeElements` expands an id to its whole subtree and takes all of it - so
 * an unlocked group wrapping a locked member would otherwise be a one-gesture
 * route around the app's only protection primitive: lock, Ctrl+G, Delete.
 */
export function subtreeLocked(store: ElementStore, id: ElementId): boolean {
  if (effectiveLocked(store, id)) return true;
  return descendantsOf(store, id).some(
    (descendantId) => store.byId[descendantId]?.locked === true
  );
}

export function effectiveVisible(store: ElementStore, id: ElementId): boolean {
  if (store.byId[id]?.visible === false) return false;
  return ancestorsOf(store, id).every((ancestorId) => store.byId[ancestorId]?.visible !== false);
}

export function maxDepth(store: ElementStore): number {
  let deepest = 0;
  walkChildren(store, store.order, (_id, _element, depth) => {
    deepest = Math.max(deepest, depth);
  });
  return deepest;
}
