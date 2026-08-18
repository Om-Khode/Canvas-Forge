/**
 * What an export actually looks at.
 *
 * `ElementStore.order` holds root ids only, so the obvious "walk the order"
 * cannot see anything inside a group - an export written that way silently
 * drops grouped content. The walks in `features/elements/tree.ts` are the fix,
 * but *which* walk depends on the serializer, and the two disagree:
 *
 *  - **PNG** goes through the same `Renderer` the screen uses, and the scene
 *    contract is a flat array with no view of the tree. `elementsToPaint`
 *    is that array: leaves in paint order with each ancestor's opacity
 *    multiplied in and effectively-hidden subtrees already dropped.
 *  - **SVG and JSON** rebuild the tree - `svg.ts` resolves `childIds` against
 *    the pool it is given, `serializeProject` nests `childIds` into `children`.
 *    They need every element at every depth, *unfiltered*: they apply a group's
 *    own opacity and `visible` themselves, so handing them the paint list would
 *    multiply group opacity in twice, and pre-filtering by `visible` would
 *    promote a hidden group's members to roots and export what the canvas
 *    refuses to paint.
 *
 * Both are derived here rather than in the dialog so the choice is one
 * documented decision with a test, instead of an expression a future edit can
 * quietly get wrong in one of three places.
 */

import {
  ancestorsOf,
  descendantsOf,
  elementsInPaintOrder,
  elementsToPaint,
  parentOf,
} from '@/features/elements/tree';
import type { CanvasElement, ElementId, ElementStore } from '@/types';

export interface ExportSubject {
  /** Flat, bottom-to-top, inherited opacity folded in. For PNG and for bounds. */
  readonly paint: readonly CanvasElement[];
  /** Every element at every depth, in paint order, unfiltered. For SVG and JSON. */
  readonly pool: readonly CanvasElement[];
  /** The ids in `pool` with no parent in `pool` - the `order` a JSON export writes. */
  readonly rootIds: readonly ElementId[];
}

/**
 * `selection` of `null` means the whole document; otherwise the subject is the
 * selected elements *plus everything inside them*, because a group is nothing
 * but a membership list and exporting one without its members exports nothing.
 */
export function exportSubject(
  store: ElementStore,
  selection: ReadonlySet<ElementId> | null
): ExportSubject {
  if (selection === null) {
    return {
      paint: elementsToPaint(store),
      pool: elementsInPaintOrder(store),
      rootIds: store.order,
    };
  }

  const ids = new Set<ElementId>();
  for (const id of selection) {
    if (store.byId[id] === undefined) continue;
    ids.add(id);
    for (const descendant of descendantsOf(store, id)) ids.add(descendant);
    // And ancestors: SVG and JSON rebuild the tree from `pool`, resolving a
    // group's `childIds` against whatever it contains and applying the
    // group's own opacity themselves. Selecting a leaf deep inside a group
    // without pulling the group in too would drop that opacity from the file
    // and promote the leaf to a root - while PNG, which reads `paint` below
    // (opacity already folded into the leaf by `elementsToPaint`), keeps it.
    // Only the ancestor *chain*, not its other children, so an unselected
    // sibling still does not tag along.
    for (const ancestor of ancestorsOf(store, id)) ids.add(ancestor);
  }

  const pool = elementsInPaintOrder(store).filter((element) => ids.has(element.id));
  return {
    paint: elementsToPaint(store).filter((element) => ids.has(element.id)),
    pool,
    // Derived from parentage rather than from `selection` itself. The selection
    // slice already refuses to hold an id nested inside another selected group,
    // but that is an invariant of a different module and this is the one place
    // where believing it wrongly would write a member twice into the file.
    rootIds: pool
      .filter((element) => {
        const parent = parentOf(store, element.id);
        return parent === null || !ids.has(parent);
      })
      .map((element) => element.id),
  };
}
