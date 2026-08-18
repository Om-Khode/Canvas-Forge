/**
 * Applying a patch map to a document.
 *
 * Split out of `elementsSlice` because it is the one part of an edit that needs
 * no store at all: patches in, a new document out, decided entirely by the
 * values involved. Keeping it here means the no-op detection that structural
 * sharing depends on is testable on its own and cannot be quietly bypassed by a
 * new action that builds its own `byId`.
 */

import type { ElementPatch, ElementPatchMap } from '@/features/elements/operations';
import type { CanvasElement, ElementId, ElementStore } from '@/types';

/**
 * Returns the *same* element when the patch is a no-op.
 *
 * Worth the extra comparison pass: dragging emits a patch on every pointermove,
 * and the ones that land on the same value (a constrained axis, a snapped
 * position) would otherwise mint a new object, defeat structural sharing, and
 * make an aborted drag look like a real change to history.
 *
 * The casts are the standard escape for walking an object's own keys
 * generically. Both sides are plain data; nothing is being widened to `any`.
 */
export function applyPatch(element: CanvasElement, patch: ElementPatch): CanvasElement {
  const before = element as unknown as Readonly<Record<string, unknown>>;
  const after = patch as unknown as Readonly<Record<string, unknown>>;

  let changed = false;
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return element;

  // Safe by construction: `ElementPatch` carries only properties that exist on
  // some variant, and the spread keeps `id` and `type` from the original.
  return { ...element, ...patch };
}

/** Returns the *same* document when no patch changed anything. */
export function patchDocument(document: ElementStore, patches: ElementPatchMap): ElementStore {
  let byId: Record<ElementId, CanvasElement> | null = null;

  for (const [id, patch] of Object.entries(patches)) {
    const element = document.byId[id];
    if (element === undefined) continue;
    const next = applyPatch(element, patch);
    if (next === element) continue;
    byId ??= { ...document.byId };
    byId[id] = next;
  }

  return byId === null ? document : { byId, order: document.order };
}
