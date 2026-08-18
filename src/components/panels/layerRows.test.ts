import { beforeEach, describe, expect, it } from 'vitest';

import { buildLayerRows, rootStepTarget, selectLayerRows } from './layerRows';
import { createGroup, createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store/index';
import type { CanvasElement, ElementStore, GroupElement, RectangleElement } from '@/types';
import { worldRect } from '@/utils/coords';

function rect(id: string): RectangleElement {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: null,
    strokeWidth: 1,
    strokeStyle: 'solid',
    cornerRadius: 0,
  };
}

function group(id: string, childIds: string[]): GroupElement {
  return {
    id,
    type: 'group',
    name: id,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    childIds,
  };
}

function store(elements: CanvasElement[], order: string[]): ElementStore {
  return { byId: Object.fromEntries(elements.map((element) => [element.id, element])), order };
}

/**
 * g1 contains a and g2; g2 contains b; c sits beside g1 at the root.
 * Every list is bottom-to-top, so the panel shows the reverse at each level.
 */
const NESTED = store(
  [rect('a'), rect('b'), rect('c'), group('g1', ['a', 'g2']), group('g2', ['b'])],
  ['g1', 'c']
);

describe('buildLayerRows', () => {
  it('lists top-first with depth, mirroring the panel', () => {
    const rows = buildLayerRows(NESTED, new Set());
    // Display order is the reverse of paint order at every level.
    expect(rows.map((r) => `${r.depth}:${r.id}`)).toEqual(['0:c', '0:g1', '1:g2', '2:b', '1:a']);
  });

  it('omits the children of a collapsed group', () => {
    const rows = buildLayerRows(NESTED, new Set(['g1']));
    expect(rows.map((r) => r.id)).toEqual(['c', 'g1']);
    expect(rows.find((r) => r.id === 'g1')).toMatchObject({ hasChildren: true, expanded: false });
  });

  it('reports sibling position for aria', () => {
    const rows = buildLayerRows(NESTED, new Set());
    expect(rows.find((r) => r.id === 'a')).toMatchObject({
      parentId: 'g1',
      indexInParent: 1,
      siblingCount: 2,
    });
  });

  it('marks a leaf as childless and never expanded', () => {
    const rows = buildLayerRows(NESTED, new Set());
    expect(rows.find((r) => r.id === 'c')).toMatchObject({
      hasChildren: false,
      expanded: false,
      parentId: null,
      depth: 0,
    });
  });

  it('collapsing an inner group leaves the outer one intact', () => {
    const rows = buildLayerRows(NESTED, new Set(['g2']));
    expect(rows.map((r) => r.id)).toEqual(['c', 'g1', 'g2', 'a']);
  });

  it('ignores a collapsed id that names nothing', () => {
    // The set is transient UI state and is never pruned, so it outlives the
    // groups it names - an undone group, a deleted one. Inert, not wedged.
    const rows = buildLayerRows(NESTED, new Set(['gone']));
    expect(rows).toHaveLength(5);
  });

  it('terminates on a cycle instead of blowing the stack', () => {
    // `childIds` survives a round trip through a project file, so a group that
    // contains its own ancestor is a document that can exist.
    const cyclic = store([group('g1', ['g2']), group('g2', ['g1'])], ['g1']);
    expect(buildLayerRows(cyclic, new Set()).map((r) => `${r.depth}:${r.id}`)).toEqual([
      '0:g1',
      '1:g2',
    ]);
  });

  it('skips a childId that names no element, without leaving a gap in the sibling count', () => {
    const broken = store([rect('a'), group('g1', ['ghost', 'a'])], ['g1']);
    const rows = buildLayerRows(broken, new Set());
    expect(rows.map((r) => r.id)).toEqual(['g1', 'a']);
    expect(rows[1]).toMatchObject({ indexInParent: 0, siblingCount: 1 });
  });
});

describe('selectLayerRows (the panel-facing memo)', () => {
  beforeEach(() => {
    resetCanvasStore();
  });

  it('returns the same rows array through a grouped drag', () => {
    // The case the whole memo exists for: a drag patches a member's position
    // on every pointermove, which re-derives the group's box every time. Task
    // 7's memo compared `childIds` by reference and `deriveGroups.ts` used to
    // reallocate that array on every box-only rewrite regardless - so this
    // rebuilt the rows array, and the panel, once per frame of a grouped drag.
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const group = createGroup([a.id, b.id]);
    useCanvasStore.getState().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    });

    const before = selectLayerRows(useCanvasStore.getState());
    useCanvasStore.getState().applyPatches({ [b.id]: { x: 90, y: 90 } });
    const after = selectLayerRows(useCanvasStore.getState());

    expect(after).toBe(before);
  });
});

describe('rootStepTarget', () => {
  const rows = buildLayerRows(NESTED, new Set());

  it('moves a root row one place down the display, which is down the order', () => {
    expect(rootStepTarget(rows, 'c', 1)).toBe(0);
  });

  it('clamps at the ends rather than wrapping', () => {
    expect(rootStepTarget(rows, 'c', -1)).toBeNull();
    expect(rootStepTarget(rows, 'g1', 1)).toBeNull();
  });

  it('refuses a nested row', () => {
    expect(rootStepTarget(rows, 'g2', 1)).toBeNull();
  });
});
