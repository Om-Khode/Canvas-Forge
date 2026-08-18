import { describe, expect, it } from 'vitest';

import { createRectangle } from './factory';
import { createGroup } from './group';
import { reparentElement, reparentLabel } from './reparent';
import type { CanvasElement, ElementId, ElementStore, GroupElement } from '@/types';
import { worldRect } from '@/utils/coords';

function rect(id: ElementId): CanvasElement {
  return { ...createRectangle(worldRect(0, 0, 10, 10)), id };
}

function groupEl(id: ElementId, childIds: readonly ElementId[]): CanvasElement {
  return { ...createGroup(childIds), id };
}

function store(elements: readonly CanvasElement[], order: readonly ElementId[]): ElementStore {
  return { byId: Object.fromEntries(elements.map((element) => [element.id, element])), order };
}

/** g1 contains a and g2; g2 contains b; c sits beside g1 at the root. */
const NESTED = store(
  [rect('a'), rect('b'), rect('c'), groupEl('g1', ['a', 'g2']), groupEl('g2', ['b'])],
  ['g1', 'c']
);

const childIds = (result: ElementStore, id: ElementId): readonly ElementId[] =>
  (result.byId[id] as GroupElement).childIds;

describe('reparentElement', () => {
  it('moves a root element into a group, at the index given', () => {
    const next = reparentElement(NESTED, 'c', 'g1', 1);
    expect(childIds(next, 'g1')).toEqual(['a', 'c', 'g2']);
    expect(next.order).toEqual(['g1']);
  });

  it('treats an index past the end as the end of the list', () => {
    const next = reparentElement(NESTED, 'c', 'g1', Number.MAX_SAFE_INTEGER);
    expect(childIds(next, 'g1')).toEqual(['a', 'g2', 'c']);
  });

  it('lifts a member out to the root', () => {
    const next = reparentElement(NESTED, 'b', null, 0);
    expect(next.order).toEqual(['b', 'g1', 'c']);
    // Emptied here; the store's derive pass is what dissolves it afterwards.
    expect(childIds(next, 'g2')).toEqual([]);
  });

  it('moves an element between two groups without touching anything else', () => {
    const next = reparentElement(NESTED, 'a', 'g2', 0);
    expect(childIds(next, 'g1')).toEqual(['g2']);
    expect(childIds(next, 'g2')).toEqual(['a', 'b']);
    // Structural sharing: the element itself is the same object, and so is
    // every element neither list named.
    expect(next.byId['a']).toBe(NESTED.byId['a']);
    expect(next.byId['c']).toBe(NESTED.byId['c']);
  });

  it('gives back the slot the id vacates when it moves within one list', () => {
    // Root order is ['g1', 'c']; index 2 is the far end *counting c*, so the
    // move is g1 to the top.
    const next = reparentElement(NESTED, 'g1', null, 2);
    expect(next.order).toEqual(['c', 'g1']);
  });

  it('returns the same store when nothing would move', () => {
    // Both of these name the slot 'c' already occupies, before and after the
    // correction above.
    expect(reparentElement(NESTED, 'c', null, 1)).toBe(NESTED);
    expect(reparentElement(NESTED, 'c', null, 2)).toBe(NESTED);
  });

  it('refuses to put a group inside its own descendant', () => {
    // Otherwise the tree stops being a tree and every recursive walk hangs.
    expect(reparentElement(NESTED, 'g1', 'g2', 0)).toBe(NESTED);
    expect(reparentElement(NESTED, 'g1', 'g1', 0)).toBe(NESTED);
  });

  it('refuses a parent that is not a group, and an id that is not there', () => {
    expect(reparentElement(NESTED, 'c', 'a', 0)).toBe(NESTED);
    expect(reparentElement(NESTED, 'gone', null, 0)).toBe(NESTED);
    expect(reparentElement(NESTED, 'c', 'gone', 0)).toBe(NESTED);
  });

  it('survives a cyclic document rather than hanging on it', () => {
    // `childIds` round-trips through a project file, so two groups naming each
    // other is a document that can exist - and the cycle check walks it.
    const cyclic = store([groupEl('g1', ['g2']), groupEl('g2', ['g1'])], ['g1']);
    expect(reparentElement(cyclic, 'g1', 'g2', 0)).toBe(cyclic);
  });
});

describe('reparentLabel', () => {
  it('names what happened, since history labels are user-visible', () => {
    expect(reparentLabel(NESTED, 'c', null)).toBe('Reorder layer');
    expect(reparentLabel(NESTED, 'c', 'g1')).toBe('Move into group');
    expect(reparentLabel(NESTED, 'b', null)).toBe('Move out of group');
  });
});
