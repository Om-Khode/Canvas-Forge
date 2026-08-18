/**
 * Layer ordering.
 *
 * Depth is the index in `order`, so reordering rewrites an array of strings and
 * leaves every element object untouched - which is exactly why a reorder is
 * cheap to snapshot. Each function returns the *same array reference* when
 * nothing moved, so history's no-op guard catches a redundant "bring forward"
 * on an element already at the top.
 *
 * Split out of `operations.ts`: these functions transform the order array and
 * never look at element geometry, so they share nothing with the transform
 * maths beyond living in the same feature.
 */

import type { ElementId } from '@/types';

function toIdSet(ids: Iterable<ElementId>): ReadonlySet<ElementId> {
  return ids instanceof Set ? ids : new Set(ids);
}

export function bringForward(
  order: readonly ElementId[],
  ids: Iterable<ElementId>
): readonly ElementId[] {
  const selected = toIdSet(ids);
  const next = [...order];
  let moved = false;
  // Top-down, so a contiguous run of selected elements shuffles up as a block
  // instead of the lower ones repeatedly bumping into the higher ones.
  for (let i = next.length - 2; i >= 0; i--) {
    const id = next[i];
    const above = next[i + 1];
    if (id === undefined || above === undefined) continue;
    if (!selected.has(id) || selected.has(above)) continue;
    next[i] = above;
    next[i + 1] = id;
    moved = true;
  }
  return moved ? next : order;
}

export function sendBackward(
  order: readonly ElementId[],
  ids: Iterable<ElementId>
): readonly ElementId[] {
  const selected = toIdSet(ids);
  const next = [...order];
  let moved = false;
  for (let i = 1; i < next.length; i++) {
    const id = next[i];
    const below = next[i - 1];
    if (id === undefined || below === undefined) continue;
    if (!selected.has(id) || selected.has(below)) continue;
    next[i] = below;
    next[i - 1] = id;
    moved = true;
  }
  return moved ? next : order;
}

function partitionToEnd(
  order: readonly ElementId[],
  ids: Iterable<ElementId>,
  toFront: boolean
): readonly ElementId[] {
  const selected = toIdSet(ids);
  const moving = order.filter((id) => selected.has(id));
  if (moving.length === 0 || moving.length === order.length) return order;
  const rest = order.filter((id) => !selected.has(id));
  const next = toFront ? [...rest, ...moving] : [...moving, ...rest];
  return next.every((id, index) => id === order[index]) ? order : next;
}

export function bringToFront(
  order: readonly ElementId[],
  ids: Iterable<ElementId>
): readonly ElementId[] {
  return partitionToEnd(order, ids, true);
}

export function sendToBack(
  order: readonly ElementId[],
  ids: Iterable<ElementId>
): readonly ElementId[] {
  return partitionToEnd(order, ids, false);
}

/** Drag-and-drop in the layers panel: pull one id out and reinsert it. */
export function moveToIndex(
  order: readonly ElementId[],
  id: ElementId,
  index: number
): readonly ElementId[] {
  const from = order.indexOf(id);
  if (from === -1) return order;
  const to = Math.min(Math.max(index, 0), order.length - 1);
  if (from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
