/**
 * Three-state property values for a multi-selection.
 *
 * The properties panel edits *a selection*, not an element, so every control
 * needs an answer to a question a single element never has to ask: what does
 * "the fill" mean when five things are selected?
 *
 * There are three answers, and collapsing any two of them produces a real bug:
 *
 *  - **uniform** - every element that *has* the property agrees. Show the value.
 *  - **mixed**   - they disagree. Show "Mixed"; editing writes one value to all.
 *  - **absent**  - no selected element has the property at all. Do not render
 *    the control.
 *
 * `mixed` and `absent` are the pair that gets conflated. Three selected lines
 * have no fill to edit - rendering a fill swatch there would let the user write
 * `fill` onto a `LineElement`, producing an element the save-time validator
 * rejects. A filled rectangle beside a hollow one *does* have a fill, it just
 * disagrees - hiding that control would make a legitimately editable property
 * unreachable. Same UI shape, opposite correct behaviour.
 *
 * The writer half exists for the same reason: applying `{ fill }` to a mixed-type
 * selection must patch only the members that carry `fill`, and silently skip the
 * rest. That filtering belongs here, next to the read logic it mirrors, rather
 * than in each section that happens to edit a shared property.
 *
 * Everything in this file is pure - no store, no React - so the interesting
 * cases are unit-testable without mounting a panel.
 */

import type { ElementPatch, ElementPatchMap } from '@/features/elements/operations';
import type { CanvasElement, ElementId } from '@/types';

export type PropertyValue<T> =
  | { readonly kind: 'uniform'; readonly value: T }
  | { readonly kind: 'mixed' }
  | { readonly kind: 'absent' };

/**
 * Every property any element variant can carry.
 *
 * Derived from `ElementPatch` rather than spelled out again: the patch type is
 * already "the intersection of every variant minus `id`/`type`", and deriving
 * from it means a new element property is editable here the moment it exists,
 * with no second list to forget to update. `Required` strips the optionality
 * `Partial` added, so `PropertyOf<'fill'>` is `string | null` and not
 * `string | null | undefined` - the difference between "no fill" and "no such
 * property", which is the whole point of this module.
 */
type ElementProperties = Required<ElementPatch>;

export type ElementPropertyKey = keyof ElementProperties;

export type PropertyOf<K extends ElementPropertyKey> = ElementProperties[K];

/* Shared singletons: these carry no data, so minting a new object per call
   would defeat the referential stability every memoized section relies on. */
export const MIXED: PropertyValue<never> = { kind: 'mixed' };
export const ABSENT: PropertyValue<never> = { kind: 'absent' };

export function uniform<T>(value: T): PropertyValue<T> {
  return { kind: 'uniform', value };
}

/**
 * Does this element carry the property at all?
 *
 * A runtime `in` check rather than a `switch` over `element.type` with a table
 * of which variant owns which key: the table would be a second source of truth
 * about the element model that can drift from the model itself, and the
 * factories guarantee every element is complete, so presence *is* the answer.
 */
export function hasProperty(element: CanvasElement, key: ElementPropertyKey): boolean {
  return key in element;
}

/**
 * The cast is the standard escape for indexing a discriminated union by a key
 * only some members carry. It is sound here because `hasProperty` gated it, and
 * nothing is widened to `any` - both sides are plain data.
 */
function readOne<K extends ElementPropertyKey>(element: CanvasElement, key: K): PropertyOf<K> {
  return (element as unknown as ElementProperties)[key];
}

/**
 * Reads one property across a selection.
 *
 * Elements that lack the property are skipped rather than counted as a
 * disagreement - selecting a rectangle and a line and editing the fill should
 * show the rectangle's fill, not "Mixed", because there is exactly one fill in
 * that selection.
 *
 * Comparison is by `Object.is`, so this is meant for the scalar properties the
 * panel edits (numbers, strings, booleans, `null`). Structural values - a
 * line's endpoints, a freehand's points - would compare as mixed whenever the
 * objects differ by identity, and no control here edits those.
 */
export function readProperty<K extends ElementPropertyKey>(
  elements: readonly CanvasElement[],
  key: K
): PropertyValue<PropertyOf<K>> {
  let result: PropertyValue<PropertyOf<K>> = ABSENT;

  for (const element of elements) {
    if (!hasProperty(element, key)) continue;
    const value = readOne(element, key);

    if (result.kind === 'absent') {
      result = { kind: 'uniform', value };
    } else if (result.kind === 'uniform' && !Object.is(result.value, value)) {
      return MIXED;
    }
  }

  return result;
}

/** True when at least one selected element carries the property. */
export function supportsProperty(
  elements: readonly CanvasElement[],
  key: ElementPropertyKey
): boolean {
  return elements.some((element) => hasProperty(element, key));
}

/**
 * Matches the convention `NumberField` and `ColorField` already use: `null`
 * renders as "Mixed". Absent maps to `null` too - a caller that renders a
 * control for an absent property has already made a different mistake, and this
 * is not the place to throw over it.
 */
export function fieldValue<T>(property: PropertyValue<T>): T | null {
  return property.kind === 'uniform' ? property.value : null;
}

/**
 * Narrows a patch to the elements it actually applies to.
 *
 * Returns one entry per element that carries at least one of the patch's keys,
 * containing only those keys. An element that carries none is omitted entirely,
 * so `applyPatches` sees nothing for it and structural sharing keeps its object
 * identity - which is what stops "set fill on a mixed selection" from marking
 * every line in it as changed.
 */
export function applicablePatches(
  elements: readonly CanvasElement[],
  patch: ElementPatch
): ElementPatchMap {
  // `Object.keys` is typed as `string[]`; the keys came from an `ElementPatch`,
  // so they are property keys by construction.
  const keys = Object.keys(patch) as ElementPropertyKey[];
  const source = patch as Readonly<Record<string, unknown>>;

  const patches: Record<ElementId, ElementPatch> = {};

  for (const element of elements) {
    let applicable: Record<string, unknown> | null = null;
    for (const key of keys) {
      if (!hasProperty(element, key)) continue;
      applicable ??= {};
      applicable[key] = source[key];
    }
    // The reassembled object is a patch by construction: its keys and values
    // were lifted straight out of one.
    if (applicable !== null) patches[element.id] = applicable;
  }

  return patches;
}
