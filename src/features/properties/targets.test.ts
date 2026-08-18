import { describe, expect, it } from 'vitest';

import { transformTargets } from './targets';
import { createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store/index';
import type { ElementId } from '@/types';
import { worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();

/** Two 10×10 squares at opposite corners of a 50×50 box, grouped. */
function seedGroup(): { a: ElementId; b: ElementId; group: ElementId } {
  resetCanvasStore();
  const a = createRectangle(worldRect(0, 0, 10, 10));
  const b = createRectangle(worldRect(40, 40, 10, 10));
  state().addElements([a, b]);
  const group = state().group([a.id, b.id]);
  expect(group).not.toBeNull();
  return { a: a.id, b: b.id, group: group ?? '' };
}

describe('transformTargets', () => {
  it('stands a group in for its leaves, since a group holds no geometry itself', () => {
    const { a, b, group } = seedGroup();

    expect(transformTargets(state().elements, [group]).map((element) => element.id)).toEqual([a, b]);
  });

  it('leaves a loose element as itself', () => {
    resetCanvasStore();
    const rect = createRectangle(worldRect(0, 0, 10, 10));
    state().addElement(rect);

    expect(transformTargets(state().elements, [rect.id])).toEqual([state().elements.byId[rect.id]]);
  });

  it('drops a locked leaf, so the field reads what an edit would change', () => {
    const { a, b, group } = seedGroup();
    state().updateElement(a, { locked: true });

    expect(transformTargets(state().elements, [group]).map((element) => element.id)).toEqual([b]);
  });

  it('keeps a directly selected locked element - the panel edits those on purpose', () => {
    resetCanvasStore();
    const rect = createRectangle(worldRect(0, 0, 10, 10));
    state().addElement(rect);
    state().updateElement(rect.id, { locked: true });

    expect(transformTargets(state().elements, [rect.id])).toHaveLength(1);
  });

  it('ignores an id that is not in the document', () => {
    resetCanvasStore();

    expect(transformTargets(state().elements, ['gone'])).toEqual([]);
  });
});
