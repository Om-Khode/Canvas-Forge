/**
 * Selection bounding boxes.
 *
 * There are two genuinely different answers here and collapsing them into one
 * `Rect` is what produces the classic bug where selecting a single tilted shape
 * draws an upright box around it that doesn't touch the shape anywhere:
 *
 *   - **One element** - the meaningful box is the element's own unrotated rect
 *     *plus* its rotation. The overlay draws a tilted frame that hugs the shape,
 *     and resize handles drag along the shape's own axes, which is what makes
 *     resizing a rotated rectangle behave.
 *   - **Many elements** - there is no shared angle to inherit, so the box is
 *     the axis-aligned union of each element's rotation-aware AABB. Resizing
 *     that group happens in world axes.
 *
 * The return type is a discriminated union so a consumer cannot read `rect`
 * without having decided which case it is in. `kind: 'multiple'` still carries
 * `rotation: 0` as a literal, so overlay and handle code can read `.rotation`
 * uniformly without a branch of its own.
 */

import type { CanvasElement, ElementId, Rect } from '@/types';
import { rotatedBounds, unionRects } from '@/utils/geometry';

export type SelectionBounds =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'single';
      readonly id: ElementId;
      /** The element's unrotated box. */
      readonly rect: Rect;
      readonly rotation: number;
    }
  | {
      readonly kind: 'multiple';
      /** Axis-aligned union of every member's rotated AABB. */
      readonly rect: Rect;
      readonly rotation: 0;
      readonly count: number;
    };

/** The element's own unrotated box, ignoring `rotation`. */
export function elementRect(element: CanvasElement): Rect {
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

/**
 * The element's world-space axis-aligned bounding box, accounting for rotation.
 *
 * This - not `elementRect` - is what culling, marquee tests, and group bounds
 * must use. A 200×20 bar rotated 90° occupies a 20×200 region of the world, and
 * using its unrotated rect would cull it off screen while it is plainly visible.
 */
export function elementBounds(element: CanvasElement): Rect {
  return rotatedBounds(elementRect(element), element.rotation);
}

export function selectionBounds(elements: readonly CanvasElement[]): SelectionBounds {
  if (elements.length === 0) return { kind: 'none' };

  const first = elements[0];
  if (first === undefined) return { kind: 'none' };

  if (elements.length === 1) {
    return {
      kind: 'single',
      id: first.id,
      rect: elementRect(first),
      rotation: first.rotation,
    };
  }

  const union = unionRects(elements.map(elementBounds));
  // Unreachable given the length check above, but `unionRects` is honest about
  // the empty case and this keeps that honesty rather than asserting past it.
  if (union === null) return { kind: 'none' };

  return { kind: 'multiple', rect: union, rotation: 0, count: elements.length };
}

/** Convenience for callers that only need the box, e.g. "zoom to selection". */
export function selectionRect(bounds: SelectionBounds): Rect | null {
  return bounds.kind === 'none' ? null : bounds.rect;
}

/**
 * Union of every element's rotated AABB - the document's content extent.
 *
 * Groups are skipped. A group's box is a *derived cache* of the union of every
 * descendant, hidden ones included (`store/deriveGroups.ts`), so counting it
 * would frame space where nothing paints - hide one member of a group and
 * zoom-to-fit would still reserve room for it. Every caller that can hand over
 * a group hands over its members in the same array, so nothing is lost by
 * ignoring the container and asking the content directly.
 */
export function contentBounds(elements: readonly CanvasElement[]): Rect | null {
  return unionRects(
    elements.filter((element) => element.visible && element.type !== 'group').map(elementBounds)
  );
}
