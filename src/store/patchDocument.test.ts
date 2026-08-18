/**
 * `patchDocument.ts` was split out of `elementsSlice.ts` on the claim that its
 * no-op detection becomes "testable on its own" - this file is what cashes
 * that in. Without it the module's only exercise was indirect, through the
 * store's `applyPatches`/`updateElement` actions.
 */

import { describe, expect, it } from 'vitest';
import { createRectangle } from '@/features/elements/factory';
import type { ElementStore } from '@/types';
import { worldRect } from '@/utils/coords';
import { applyPatch, patchDocument } from './patchDocument';

describe('applyPatch', () => {
  it('returns the same element when the patch matches every value already there', () => {
    const element = createRectangle(worldRect(0, 0, 10, 10));

    expect(applyPatch(element, { x: element.x, y: element.y })).toBe(element);
  });

  it('returns a new object, with the other fields intact, when a value differs', () => {
    const element = createRectangle(worldRect(0, 0, 10, 10));

    const next = applyPatch(element, { x: 99 });

    expect(next).not.toBe(element);
    expect(next.x).toBe(99);
    expect(next.y).toBe(element.y);
    expect(next.id).toBe(element.id);
  });

  it('treats an empty patch as a no-op', () => {
    const element = createRectangle(worldRect(0, 0, 10, 10));

    expect(applyPatch(element, {})).toBe(element);
  });
});

describe('patchDocument', () => {
  function store(...elements: ReturnType<typeof createRectangle>[]): ElementStore {
    return {
      byId: Object.fromEntries(elements.map((element) => [element.id, element])),
      order: elements.map((element) => element.id),
    };
  }

  it('returns the same document when every patch is a no-op', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const document = store(a, b);

    const next = patchDocument(document, { [a.id]: { x: a.x }, [b.id]: { y: b.y } });

    expect(next).toBe(document);
  });

  it('rebuilds byId only for the element that actually changed', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const document = store(a, b);

    const next = patchDocument(document, { [a.id]: { x: 5 } });

    expect(next).not.toBe(document);
    expect(next.byId).not.toBe(document.byId);
    expect(next.byId[a.id]?.x).toBe(5);
    // Structural sharing: the untouched element is the same object reference.
    expect(next.byId[b.id]).toBe(b);
    expect(next.order).toBe(document.order);
  });

  it('ignores a patch for an id the document does not have', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const document = store(a);

    const next = patchDocument(document, { missing: { x: 5 } });

    expect(next).toBe(document);
  });
});
