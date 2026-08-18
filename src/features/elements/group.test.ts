import type { CanvasElement, ElementId, ElementStore } from '@/types';
import { worldRect } from '@/utils/coords';
import { describe, expect, it } from 'vitest';
import { createRectangle } from './factory';
import { canGroup, createGroup, groupElements, ungroupElements } from './group';

function rect(id: ElementId, x = 0, y = 0): CanvasElement {
  return { ...createRectangle(worldRect(x, y, 10, 10)), id };
}

function groupEl(id: ElementId, childIds: readonly ElementId[]): CanvasElement {
  return { ...createGroup(childIds), id };
}

function store(elements: readonly CanvasElement[], order: readonly ElementId[]): ElementStore {
  return { byId: Object.fromEntries(elements.map((element) => [element.id, element])), order };
}

/** `groupElements`, for the cases that are asserting what the group looks like. */
function grouped(
  s: ElementStore,
  ids: readonly ElementId[]
): { store: ElementStore; groupId: ElementId } {
  const result = groupElements(s, ids);
  if (result === null) throw new Error(`expected ${ids.join()} to group`);
  return result;
}

describe('createGroup', () => {
  it('starts with a derived-empty box and no rotation', () => {
    // Geometry is a cache the store fills in; the factory must not invent one.
    const group = createGroup(['a', 'b']);
    expect(group.type).toBe('group');
    expect(group.childIds).toEqual(['a', 'b']);
    expect(group.rotation).toBe(0);
    expect(group.width).toBe(0);
    expect(group.height).toBe(0);
  });

  it('auto-names from the existing document', () => {
    const first = createGroup(['a'], { existing: [] });
    expect(first.name).toBe('Group 1');
  });

  it('gives every group a distinct id', () => {
    expect(createGroup(['a']).id).not.toBe(createGroup(['a']).id);
  });
});

describe('groupElements', () => {
  it('places the group at the z-position of its topmost member', () => {
    const s = store([rect('a'), rect('b'), rect('c')], ['a', 'b', 'c']);
    const result = grouped(s, ['a', 'b']);
    // 'b' was the topmost member (later in the bottom-to-top order), so the
    // group takes its slot and 'c' stays above.
    expect(result.store.order).toEqual([result.groupId, 'c']);
  });

  it('places the group above what was below its topmost member', () => {
    // The other side of the same arithmetic: skipping a member changes how far
    // the slot shifts down once the members leave the list.
    const s = store([rect('a'), rect('b'), rect('c')], ['a', 'b', 'c']);
    const result = grouped(s, ['a', 'c']);
    expect(result.store.order).toEqual(['b', result.groupId]);
  });

  it('keeps members in their existing relative order', () => {
    const s = store([rect('a'), rect('b'), rect('c')], ['a', 'b', 'c']);
    const result = grouped(s, ['c', 'a']);
    expect(result.store.byId[result.groupId]).toMatchObject({ childIds: ['a', 'c'] });
  });

  it('does not move a single member', () => {
    // The whole point: a group has no transform, so the members keep the world
    // coordinates they had and nothing shifts on screen.
    const s = store([rect('a', 10, 20), rect('b', 90, 90)], ['a', 'b']);
    const result = grouped(s, ['a', 'b']);
    expect(result.store.byId['a']).toBe(s.byId['a']);
    expect(result.store.byId['b']).toMatchObject({ x: 90, y: 90 });
  });

  it('refuses to group fewer than two items', () => {
    const s = store([rect('a')], ['a']);
    expect(groupElements(s, ['a'])).toBeNull();
    expect(canGroup(s, ['a'])).toBe(false);
  });

  it('groups only siblings, ignoring ids from inside another group', () => {
    // Grouping a group and one of its own children is meaningless - and it is
    // also the only way grouping could nest a group inside its own descendant.
    const s = store([groupEl('g', ['a']), rect('a'), rect('b')], ['g', 'b']);
    const result = grouped(s, ['g', 'a', 'b']);
    expect(result.store.byId[result.groupId]).toMatchObject({ childIds: ['g', 'b'] });
  });

  it('refuses a selection spanning two parents', () => {
    // Grouping these would have to lift 'a' out of 'g', which is reparenting,
    // not grouping.
    const s = store([groupEl('g', ['a']), rect('a'), rect('b')], ['g', 'b']);
    expect(groupElements(s, ['a', 'b'])).toBeNull();
  });

  it('groups inside a parent group without touching the root order', () => {
    const s = store([groupEl('g', ['a', 'b', 'c']), rect('a'), rect('b'), rect('c')], ['g']);
    const result = grouped(s, ['a', 'b']);
    expect(result.store.order).toBe(s.order);
    expect(result.store.byId['g']).toMatchObject({ childIds: [result.groupId, 'c'] });
  });
});

describe('ungroupElements', () => {
  it('splices children back at the group position', () => {
    const s = store(
      [rect('x'), groupEl('g', ['a', 'b']), rect('a'), rect('b'), rect('y')],
      ['x', 'g', 'y']
    );
    const next = ungroupElements(s, ['g']);
    // Back where the group stood, not on top of the stack.
    expect(next.order).toEqual(['x', 'a', 'b', 'y']);
    expect(next.byId['g']).toBeUndefined();
    expect(next.byId['a']).toBe(s.byId['a']);
  });

  it('splices children back into a parent group', () => {
    const s = store(
      [groupEl('outer', ['x', 'inner']), rect('x'), groupEl('inner', ['a']), rect('a')],
      ['outer']
    );
    const next = ungroupElements(s, ['inner']);
    expect(next.byId['outer']).toMatchObject({ childIds: ['x', 'a'] });
    expect(next.order).toBe(s.order);
  });

  it('leaves a non-group untouched', () => {
    const s = store([rect('a')], ['a']);
    expect(ungroupElements(s, ['a'])).toBe(s);
  });
});
