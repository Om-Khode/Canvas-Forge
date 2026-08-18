/**
 * The three group invariants the document has to hold at rest.
 *
 *  1. **A group's box is output, not input.** It is a cache of the union of its
 *     leaves, so it is recomputed on the slice's single write path rather than
 *     at each call site. One caller that forgot - a nudge, an align, a paste -
 *     would leave a box that silently disagrees with what is drawn inside it,
 *     and the bug would surface later as a selection frame in the wrong place.
 *
 *  2. **A group always has at least one member.** An empty group is a state the
 *     UI cannot represent: nothing to click, nothing to draw, a row in the
 *     layers panel that selects an invisible nothing. Deleting the last member
 *     dissolves it.
 *
 *  3. **Every element has exactly one home** - one parent group, or the root
 *     order, never both and never two parents. See `withSingleHome`.
 *
 * All three are enforced here rather than in the actions, because "every write
 * is checked" is a property of one funnel and merely a habit of many call sites.
 *
 * Structural sharing is the constraint that shapes the implementation: history
 * snapshots are pointers to this document (docs/architecture.md#history), so a
 * pass that returns a fresh object every time - or clones elements it did not
 * change - would turn one moved rectangle into a full document copy per frame.
 * Nothing is allocated unless something actually moved.
 */

import { deriveGroupRect, elementsInPaintOrder, isGroup } from '@/features/elements/tree';
import type { CanvasElement, ElementId, ElementStore, GroupElement, Rect } from '@/types';

/** The box of a group with no leaves anywhere beneath it. It dissolves next pass. */
const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * `===`, except two `NaN`s agree. Validation enforces finite geometry on load,
 * so this is defensive, not expected: without it, a leaf that somehow carries
 * non-finite geometry would make `settled` false forever (`NaN === NaN` is
 * always false), rewriting every ancestor group on every write with an
 * identical-looking value and burning the fixed-point loop's full iteration
 * budget instead of settling in two passes.
 *
 * Not `Object.is` - `Object.is(-0, 0)` is false, and `unionRects` can produce
 * `-0`, so that swap would turn a settled box into permanent churn instead of
 * removing it.
 */
function sameNumber(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/* ------------------------------------------------------------ one home -- */

/**
 * Records who owns each child, dropping self-membership and every claim after
 * the first. Returns whether a second, costlier resolution pass is needed.
 *
 * That return value is named for its effect, not its cause - the flag is not
 * "there was a two-parent contest." Three different anomalies set it, and none
 * of the three is that: a group listing itself as its own child, a group
 * listing the same child twice in its own list, and a genuine contest between
 * two different groups. `resolveClaims` cannot tell which one happened without
 * doing the expensive walk anyway, and it does not need to - the `kept` Set in
 * `withSingleHome` throws out every losing claim regardless of which anomaly
 * produced it, so one flag covering all three is enough.
 */
function claimChildren(
  elements: Iterable<CanvasElement>,
  claims: Map<ElementId, ElementId>
): boolean {
  let contested = false;
  for (const element of elements) {
    if (!isGroup(element)) continue;
    for (const childId of element.childIds) {
      if (childId === element.id || claims.has(childId)) {
        contested = true;
        continue;
      }
      claims.set(childId, element.id);
    }
  }
  return contested;
}

/**
 * The winning parent for every claimed id.
 *
 * The cheap pass comes first and is the only one that runs when `claimChildren`
 * finds no anomaly at all - self-membership, a repeated child, or a real
 * two-parent contest: one walk over the child lists, no allocation beyond the
 * map. It picks an arbitrary winner, which is fine precisely because it also
 * reports whether anything of the sort *did* turn up - and when it did, the
 * whole thing is redone in document order, where the winner is the parent the
 * renderer already draws the child under (`elementsInPaintOrder` hands each id
 * to the first group that reaches it). Making the stored membership agree with
 * the drawing is the only tie-break that cannot surprise a user.
 *
 * The second sweep over `byId` catches groups that `order` cannot reach - the
 * group half of a paste, before the pruning below has run - which still own
 * whatever nobody ahead of them claimed. It is idempotent for the groups the
 * first sweep already processed. On a corrupt file this sweep can let a group
 * that `order` never reached win a claim on a root element, which then gets
 * pruned out of `order` by `withSingleHome` below and left unreachable from the
 * paint walk - worse than nothing, but every normal path puts a group in
 * `order` via `addElements`, so this needs a hand-edited or truncated file to
 * reach at all.
 */
function resolveClaims(store: ElementStore): ReadonlyMap<ElementId, ElementId> {
  const claims = new Map<ElementId, ElementId>();
  if (!claimChildren(Object.values(store.byId), claims)) return claims;

  claims.clear();
  claimChildren(elementsInPaintOrder(store), claims);
  claimChildren(Object.values(store.byId), claims);
  return claims;
}

/**
 * Invariant 3: one home per element.
 *
 * Nothing in the type system stops two groups naming the same child, or a child
 * appearing in `order` *and* in a group - and both are reachable from real code
 * paths. A cross-tab paste arrives as untrusted text whose `childIds` name a
 * foreign document's ids, and `addElements` appends every incoming element to
 * the root order, members included. Left alone, the same element would be a
 * child of two parents and a root at once: `parentOf` would answer whichever
 * group happened to be written last, the layers panel would list it twice, and
 * every consumer would have to carry its own "already seen" set to compensate -
 * which is exactly what the SVG exporter had to do before this existed.
 *
 * The rule is asymmetric on purpose: **a surviving parent beats the root
 * order.** The other way round would make a pasted group lose the members that
 * arrived with it, since `addElements` appends them all as roots.
 *
 * Runs before the derive passes rather than inside them, so `deriveGroupRect`
 * never sees a membership that is about to change and no box has to settle
 * twice.
 */
function withSingleHome(store: ElementStore): ElementStore {
  const claims = resolveClaims(store);

  const rewritten = new Map<ElementId, GroupElement>();
  for (const element of Object.values(store.byId)) {
    if (!isGroup(element)) continue;
    // A `Set` rather than a filter: it drops the losing claims *and* a child
    // listed twice by the same group, in one pass, keeping the original order.
    const kept = new Set<ElementId>();
    for (const childId of element.childIds) {
      if (claims.get(childId) === element.id) kept.add(childId);
    }
    if (kept.size !== element.childIds.length) {
      rewritten.set(element.id, { ...element, childIds: [...kept] });
    }
  }

  const pruned = store.order.filter((id) => !claims.has(id));
  const order = pruned.length === store.order.length ? store.order : pruned;
  if (rewritten.size === 0 && order === store.order) return store;

  // `byId` is rebuilt only when a membership list actually changed. Keeping the
  // same object otherwise is not just allocation: `tree.ts` caches the parent
  // index against it, and a fresh map would throw that away on every write.
  if (rewritten.size === 0) return { byId: store.byId, order };

  const byId: Record<ElementId, CanvasElement> = {};
  for (const [id, element] of Object.entries(store.byId)) {
    byId[id] = rewritten.get(id) ?? element;
  }
  return { byId, order };
}

/* ------------------------------------------------------ box and members -- */

/**
 * One sweep: dissolve the groups that have no live members, re-derive the boxes
 * of the ones that survive. Returns the *same* store when both were already true.
 */
function derivePass(store: ElementStore): ElementStore {
  const dissolved = new Set<ElementId>();
  const live = (id: ElementId): boolean => store.byId[id] !== undefined && !dissolved.has(id);

  // Dissolution is transitive - a group whose only member was itself dissolved
  // is now empty too. `dissolved` grows as this loop runs, so a parent visited
  // *after* its child collapses in the same sweep; one visited before it does
  // not, which is why the caller runs this to a fixed point.
  for (const element of Object.values(store.byId)) {
    if (isGroup(element) && !element.childIds.some(live)) dissolved.add(element.id);
  }

  const rewritten = new Map<ElementId, GroupElement>();
  for (const element of Object.values(store.byId)) {
    if (!isGroup(element) || dissolved.has(element.id)) continue;

    // Read from `store`, not from a partially-updated draft: a dissolved group
    // by definition has no live leaves under it, so it contributes nothing to
    // any ancestor's union and the two agree.
    const rect = deriveGroupRect(store, element.id) ?? EMPTY_RECT;
    // Same idiom as `order` below: `filter` always allocates, so a box-only
    // change (a drag, with membership untouched) must not fabricate a fresh
    // array here. `layerRows.ts`'s row memo compares every group's `childIds`
    // by reference, and a new array on every pointermove of a grouped drag was
    // exactly the "panel re-renders on every frame" failure structural sharing
    // in this file exists to prevent.
    const filteredChildIds = element.childIds.filter(live);
    const childIds =
      filteredChildIds.length === element.childIds.length
        ? element.childIds
        : filteredChildIds;
    const settled =
      childIds.length === element.childIds.length &&
      sameNumber(rect.x, element.x) &&
      sameNumber(rect.y, element.y) &&
      sameNumber(rect.width, element.width) &&
      sameNumber(rect.height, element.height);
    if (settled) continue;

    rewritten.set(element.id, { ...element, childIds, ...rect });
  }

  if (dissolved.size === 0 && rewritten.size === 0) return store;

  const byId: Record<ElementId, CanvasElement> = {};
  for (const [id, element] of Object.entries(store.byId)) {
    if (dissolved.has(id)) continue;
    byId[id] = rewritten.get(id) ?? element;
  }
  // A dissolved group has to leave the z-order too. Rebuilt only when one did,
  // so a pure box re-derivation keeps the order array reference-identical.
  const order = store.order.filter((id) => !dissolved.has(id));
  return { byId, order: order.length === store.order.length ? store.order : order };
}

/**
 * Applies all three invariants to a document, to a fixed point.
 *
 * The loop exists for one case: dissolving an empty group can empty its parent,
 * and `derivePass` only notices that if it happens to visit the parent second.
 * Boxes settle in the first pass, so every pass after it must have dissolved at
 * least one group to have changed anything - the number of groups therefore
 * bounds the chain. The cap is a guard against a malformed document (a cycle in
 * `childIds` survives a round trip through a project file), not an expected
 * cost: the normal shape is one pass plus the no-op that ends the loop.
 */
export function withDerivedGroups(store: ElementStore): ElementStore {
  let groupCount = 0;
  for (const element of Object.values(store.byId)) {
    if (isGroup(element)) groupCount += 1;
  }
  // The overwhelmingly common document has no groups at all, and this scan is
  // on the write path - one type check per element, then out.
  if (groupCount === 0) return store;

  let current = withSingleHome(store);
  for (let pass = 0; pass <= groupCount; pass += 1) {
    const next = derivePass(current);
    if (next === current) break;
    current = next;
  }
  return current;
}
