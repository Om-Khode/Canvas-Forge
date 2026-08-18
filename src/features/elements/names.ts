/**
 * Auto-generated layer names.
 *
 * Split out of `factory.ts` for two reasons that happen to point the same way.
 * It is the one piece of creation that every factory needs but none of them own,
 * so `group.ts` had to import `factory.ts` while `factory.ts` re-exported
 * `group.ts` - a cycle that worked only because both references were hoisted
 * function declarations. And naming is genuinely a separate concern from
 * building geometry: it reads the document, where the factories read a drag.
 *
 * **Names are derived from the existing document**, not from a counter held in
 * the store. A counter drifts: it survives deletes, so it either leaks gaps or -
 * if you reset it - produces duplicate "Rectangle 2"s. Scanning the current
 * names for the highest suffix of the same type is O(n) once per creation and
 * cannot collide with a name that is actually on screen.
 */

import type { CanvasElement, ElementType } from '@/types';

export const ELEMENT_TYPE_LABEL: Readonly<Record<ElementType, string>> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text',
  image: 'Image',
  freehand: 'Path',
  group: 'Group',
};

/**
 * `"Rectangle 4"` - one more than the highest numbered rectangle currently in
 * the document. Highest-plus-one rather than count-plus-one: with three
 * rectangles named 1, 2, 3, deleting #2 and adding one yields 4, not a second 3.
 */
export function nextElementName(type: ElementType, existing: readonly CanvasElement[]): string {
  const label = ELEMENT_TYPE_LABEL[type];
  const pattern = new RegExp(`^${label} (\\d+)$`);

  let highest = 0;
  for (const element of existing) {
    if (element.type !== type) continue;
    const match = pattern.exec(element.name);
    const captured = match?.[1];
    if (captured === undefined) continue;
    highest = Math.max(highest, Number.parseInt(captured, 10));
  }
  return `${label} ${highest + 1}`;
}
