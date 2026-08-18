/**
 * Align and distribute.
 *
 * Both are pure `(elements) => patches`, so the store applies them inside one
 * transaction and the whole "align 5 elements" reads as a single undo step.
 *
 * Everything is computed against each element's **rotation-aware AABB**, not
 * its raw `{x, y, width, height}`. Aligning a 45°-rotated square by its
 * unrotated box would leave it visibly proud of the edge it was aligned to,
 * because the box it occupies on screen is wider than the box it stores. The
 * patch is then expressed as a *delta* on `x`/`y` - the element's own origin
 * moves by however far its AABB had to move - which keeps rotation untouched
 * and works identically for rotated and unrotated elements.
 */

import { elementAABB, unionBounds } from '@/features/elements/operations';
import type { ElementPatch, ElementPatchMap } from '@/features/elements/operations';
import type { CanvasElement, ElementId, Rect } from '@/types';

export type AlignEdge = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom';

export type DistributeAxis = 'horizontal' | 'vertical';

/**
 * How one aligned *item* expands into the elements that actually move.
 *
 * An item can be a group, and a group has no geometry of its own - its box is a
 * cache the store derives from its members, so a patch naming the group is
 * recomputed away in the same write. The measuring still happens on the item
 * (the group's box is exactly the extent the user sees and is aligning), and
 * only the resulting delta is handed down, which is what keeps the members'
 * relative offsets untouched.
 *
 * An expander rather than an `ElementStore` parameter because this module is
 * pure transform maths and has no business knowing what a document is. The
 * default is the identity, which is both what a group-free caller wants and
 * exactly what this file did before groups existed.
 */
export type MoveTargets = (element: CanvasElement) => readonly CanvasElement[];

const ITSELF: MoveTargets = (element) => [element];

/** Where an element's AABB must end up along the relevant axis. */
function targetPosition(edge: AlignEdge, box: Rect, group: Rect): number {
  switch (edge) {
    case 'left':
      return group.x;
    case 'center-x':
      return group.x + group.width / 2 - box.width / 2;
    case 'right':
      return group.x + group.width - box.width;
    case 'top':
      return group.y;
    case 'center-y':
      return group.y + group.height / 2 - box.height / 2;
    case 'bottom':
      return group.y + group.height - box.height;
  }
}

function isHorizontal(edge: AlignEdge): boolean {
  return edge === 'left' || edge === 'center-x' || edge === 'right';
}

/**
 * Aligns every element to the corresponding edge of the selection's bounding
 * box. Fewer than two elements is a no-op: a single element is already aligned
 * to a box that is exactly itself, so the operation would push an empty undo
 * entry for a visibly-nothing change.
 */
export function alignElements(
  elements: readonly CanvasElement[],
  edge: AlignEdge,
  expand: MoveTargets = ITSELF
): ElementPatchMap {
  if (elements.length < 2) return {};

  const group = unionBounds(elements);
  const horizontal = isHorizontal(edge);
  const patches: Record<ElementId, ElementPatch> = {};

  for (const element of elements) {
    const box = elementAABB(element);
    const current = horizontal ? box.x : box.y;
    const delta = targetPosition(edge, box, group) - current;
    if (delta === 0) continue;
    for (const target of expand(element)) {
      patches[target.id] = horizontal ? { x: target.x + delta } : { y: target.y + delta };
    }
  }
  return patches;
}

/**
 * Evens out the *gaps* between elements, leaving the two outermost where they
 * are.
 *
 * Distributing by centre instead is the other common definition, and it is the
 * wrong one when the elements are different sizes: equal centre spacing leaves
 * visibly uneven whitespace, which is the thing the user is actually trying to
 * fix. Equal gaps is what a designer means by "distribute".
 *
 *   gap = (span - Σ sizes) / (n - 1)
 *
 * A negative gap is legitimate - it means the elements overlap and will keep
 * overlapping, evenly.
 *
 * Fewer than three elements is a no-op: with two, the gap between them is
 * already the only gap there is.
 */
export function distributeElements(
  elements: readonly CanvasElement[],
  axis: DistributeAxis,
  expand: MoveTargets = ITSELF
): ElementPatchMap {
  if (elements.length < 3) return {};

  const horizontal = axis === 'horizontal';
  const measured = elements
    .map((element) => ({ element, box: elementAABB(element) }))
    .sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));

  const first = measured[0];
  const last = measured[measured.length - 1];
  if (first === undefined || last === undefined) return {};

  const start = horizontal ? first.box.x : first.box.y;
  const end = horizontal ? last.box.x + last.box.width : last.box.y + last.box.height;

  let totalSize = 0;
  for (const item of measured) {
    totalSize += horizontal ? item.box.width : item.box.height;
  }

  const gap = (end - start - totalSize) / (measured.length - 1);

  const patches: Record<ElementId, ElementPatch> = {};
  let cursor = start;
  for (const { element, box } of measured) {
    const size = horizontal ? box.width : box.height;
    const current = horizontal ? box.x : box.y;
    const delta = cursor - current;
    if (delta !== 0) {
      for (const target of expand(element)) {
        patches[target.id] = horizontal ? { x: target.x + delta } : { y: target.y + delta };
      }
    }
    cursor += size + gap;
  }
  return patches;
}
