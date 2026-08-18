/**
 * Copy/paste and duplicate.
 *
 * Split from `factory.ts` because cloning is the one creation path that starts
 * from existing elements rather than from geometry, and it has a contract of its
 * own - the id map - that the factories don't share.
 */

import { PASTE_OFFSET } from '@/constants';
import type { CanvasElement, ElementId, Vec2 } from '@/types';
import { createId } from '@/utils/id';

export interface CloneResult {
  readonly elements: readonly CanvasElement[];
  /**
   * Old id → new id for every cloned element.
   *
   * `GroupElement.childIds` is the reference this map exists for, and it is
   * rewritten through it below. The alternative - a per-element `createId()`
   * scattered through the copy path - is precisely how a copy ends up pointing
   * at the original's members.
   */
  readonly idMap: ReadonlyMap<ElementId, ElementId>;
}

/**
 * Fresh ids, offset so the copy is visible on top of the original, names
 * preserved (the layers panel showing two "Rectangle 3"s matches what every
 * other editor does after a duplicate).
 *
 * **A clone set is self-contained.** A `childId` with no counterpart in this
 * set is dropped rather than carried across, because carrying it would make the
 * copy claim an element that already has a parent - the original's. That is
 * live on two paths: duplicating a group, and pasting one from another tab,
 * where the ids in the payload belong to a document this one has never seen and
 * may collide with real ids here. Callers that want the members copied too must
 * put them in `elements`; `createCommands` expands a selection to its
 * descendants for exactly this reason.
 */
export function cloneElements(
  elements: readonly CanvasElement[],
  offset: Vec2 = { x: PASTE_OFFSET, y: PASTE_OFFSET }
): CloneResult {
  const idMap = new Map<ElementId, ElementId>();
  for (const element of elements) {
    idMap.set(element.id, createId());
  }

  const cloned = elements.map((element): CanvasElement => {
    // The fallback is unreachable: the map was just built from this same array.
    // A fresh id rather than a throw keeps a paste from taking the app down.
    const id = idMap.get(element.id) ?? createId();
    const x = element.x + offset.x;
    const y = element.y + offset.y;

    if (element.type === 'group') {
      const childIds: ElementId[] = [];
      for (const childId of element.childIds) {
        const mapped = idMap.get(childId);
        if (mapped !== undefined) childIds.push(mapped);
      }
      return { ...element, id, x, y, childIds };
    }
    return { ...element, id, x, y };
  });

  return { elements: cloned, idMap };
}
