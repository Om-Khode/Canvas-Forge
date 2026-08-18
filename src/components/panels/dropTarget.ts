/**
 * Where a dragged row lands.
 *
 * In a flat list a drop is one integer - which gap. In a tree it is a pair,
 * (parent, index), and the same visual gap can mean several different parents:
 * the gap below the last member of a group is also the gap below the group, and
 * also the gap below whatever the group itself sits in. Three zones per row
 * resolve that from the pointer alone with no extra state: the outer quarters
 * mean "beside this row", the middle half means "inside it" when the row is a
 * group. Finder and comparable trees behave the same way.
 *
 * **Pure over the row array, and deliberately so.** The panel windows its DOM,
 * so a drop target three hundred rows down the list has no element to
 * hit-test against - `rowIndex` comes from arithmetic on the pointer position
 * (`useLayerReorder`) and everything here reads the row model rather than the
 * DOM. It also makes the refusals testable without a browser, which matters
 * because a refusal that only the store enforces is a refusal the *indicator*
 * does not know about, and the panel would then draw a landing place for a drop
 * that will not happen.
 */

import type { LayerRow } from './layerRows';
import type { ElementId } from '@/types';

export type DropZone = 'before' | 'into' | 'after';

/** Share of the row height, at each end, that means "beside" rather than "inside". */
const EDGE_FRACTION = 0.25;

/**
 * A group splits three ways - quarters at each end for "beside", half in the
 * middle for "inside" - because it has an inside to offer. A leaf has none,
 * so it splits 50/50 at its own midpoint instead of the same quarter used on
 * a group's edges.
 *
 * The two are not the same fraction for a reason sharper than symmetry: a
 * leaf sitting at a level boundary is the *only* way to reach "the root order,
 * beside this group" from the side away from the group. In `[g1, m1, m2,
 * loose]`, "before loose" and "after m2" are the two disjoint targets that
 * mean different documents, and at a 32px row a quarter-height edge leaves
 * "before loose" an 8px strip - half of what "after m2" already gets from
 * `g1`'s own bottom quarter. Both of the brief's leaf assertions
 * (`zoneAt(2, 32, false)` → before, `zoneAt(16, 32, false)` → after) hold
 * under either split, so this does not reopen that brief - it closes the gap
 * the brief didn't have reason to consider.
 */
export function zoneAt(offsetInRow: number, rowHeight: number, isGroup: boolean): DropZone {
  if (!isGroup) return offsetInRow < rowHeight * 0.5 ? 'before' : 'after';
  const edge = rowHeight * EDGE_FRACTION;
  if (offsetInRow < edge) return 'before';
  return offsetInRow > rowHeight - edge ? 'after' : 'into';
}

/** A place in the document: whose child list, and where in it. */
export interface DropTarget {
  /** `null` is the root order. */
  readonly parentId: ElementId | null;
  /**
   * Insertion index in that list **as it currently stands**, bottom-to-top -
   * the dragged id included, if it is already in the list. `reparent` owns the
   * pull-it-out-first correction, because only the store knows where the id
   * currently sits. Anything past the end means "at the end".
   */
  readonly index: number;
}

export function resolveDrop(
  rows: readonly LayerRow[],
  rowIndex: number,
  zone: DropZone
): DropTarget | null {
  const row = rows[rowIndex];
  if (row === undefined) return null;

  if (zone === 'into') {
    // Rows are top-first while childIds are bottom-to-top, so the visual top of
    // a group - where a dropped row should appear - is the end of its child
    // list. A collapsed group has no child rows to count, which is the other
    // reason this is expressed as "the end" rather than as a number.
    return { parentId: row.id, index: Number.MAX_SAFE_INTEGER };
  }

  const fromTop = zone === 'before' ? row.indexInParent : row.indexInParent + 1;
  // `siblingCount` counts the *displayed* list - already pruned by
  // `buildLayerRows` of ids naming a missing element and ids already reached
  // through a cycle - not the raw `childIds`/`order` array `reparentElement`
  // splices into. The two diverge only for a malformed document that the
  // on-disk nested format cannot express and the next commit prunes anyway.
  return { parentId: row.parentId, index: row.siblingCount - fromTop };
}

/** A resolved drop, with the row the indicator hangs off. */
export interface DropPlan extends DropTarget {
  readonly rowIndex: number;
  readonly zone: DropZone;
}

/**
 * The whole decision: which zone the pointer is in, where that lands, and
 * whether the drop is allowed at all. `null` means "do not offer this" - the
 * panel draws no indicator and the pointerup writes nothing.
 *
 * Three things are refused, and each would otherwise be a real defect rather
 * than a cosmetic one:
 *
 *  - **Into the dragged row's own subtree.** A group inside its own descendant
 *    stops the tree being a tree, and every recursive walk in
 *    `features/elements/tree.ts` would run forever without its visited set.
 *    `reparent` checks this again with `wouldCreateCycle` - that is the
 *    authority; this is what stops the interface offering it in the first place.
 *  - **A drop that changes nothing.** Back where it started, or into the group
 *    it already tops. History's guard would probably catch it, but relying on
 *    that means the write is issued and the answer arrives by accident; not
 *    issuing it is the honest version.
 *  - **A row the drag does not know**, which is a stale pointer against rows
 *    that were rebuilt underneath it.
 *
 * `fromIndex` is the dragged row's display index, resolved once by the caller
 * when the gesture began (`LayerRow`'s own `index` at pointerdown) rather
 * than re-derived here. No document write happens mid-drag, so that index
 * cannot change over the gesture's lifetime - scanning `rows` for it on every
 * pointermove would be an O(rows) `findIndex` on the one path this list's
 * whole design (fixed-height virtualization) exists to keep off the per-frame
 * hot path.
 */
export function planDrop(
  rows: readonly LayerRow[],
  draggingId: ElementId,
  fromIndex: number,
  rowIndex: number,
  offsetInRow: number,
  rowHeight: number
): DropPlan | null {
  const hovered = rows[rowIndex];
  if (hovered === undefined) return null;

  // Validated rather than trusted blindly: a stale `fromIndex` against rows
  // rebuilt underneath the gesture is the same "row the drag does not know"
  // refusal this used to get for free out of `findIndex` returning -1.
  const dragged = rows[fromIndex];
  if (dragged === undefined || dragged.id !== draggingId) return null;

  // Everything nested under the dragged row displays as the contiguous run of
  // deeper rows beneath it, so the subtree test is a scan rather than a walk -
  // and it needs no cycle guard for the same reason, the rows it reads were
  // already built by one.
  if (rowIndex > fromIndex && rowIndex < subtreeEnd(rows, fromIndex)) return null;

  // `hasChildren` stands in for "is a group": a group always has at least one
  // member (`store/deriveGroups.ts` invariant 2), so the two agree, and unlike
  // `expanded` it is still true for a folded group - which must remain a drop
  // target, since folding is how a big group gets out of the way.
  const zone = zoneAt(offsetInRow, rowHeight, hovered.hasChildren);
  if (zone === 'into' && rowIndex === fromIndex) return null;

  const target = resolveDrop(rows, rowIndex, zone);
  if (target === null) return null;

  if (zone === 'into') {
    // Already this group's topmost member, which is exactly where an into drop
    // would put it.
    if (dragged.parentId === hovered.id && dragged.indexInParent === 0) return null;
  } else if (target.parentId === dragged.parentId) {
    // Same list: compare against where the row already sits, in the same
    // bottom-to-top space, with the same pull-it-out-first correction
    // `reparent` will apply.
    const from = dragged.siblingCount - 1 - dragged.indexInParent;
    const to = target.index > from ? target.index - 1 : target.index;
    if (to === from) return null;
  }

  return { rowIndex, zone, parentId: target.parentId, index: target.index };
}

/** First row index past `rowIndex` and everything nested under it. */
function subtreeEnd(rows: readonly LayerRow[], rowIndex: number): number {
  const depth = rows[rowIndex]?.depth;
  if (depth === undefined) return rowIndex + 1;
  for (let i = rowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined || row.depth <= depth) return i;
  }
  return rows.length;
}
