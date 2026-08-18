import { describe, expect, it } from 'vitest';

import { planDrop, resolveDrop, zoneAt } from './dropTarget';
import { buildLayerRows } from './layerRows';
import type { CanvasElement, ElementStore, GroupElement, RectangleElement } from '@/types';

const ROW = 32;

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
 * Every list is bottom-to-top, so the rows are the reverse at each level:
 *
 *   0  c    depth 0
 *   1  g1   depth 0
 *   2    g2   depth 1
 *   3      b    depth 2
 *   4    a    depth 1
 */
const NESTED = store(
  [rect('a'), rect('b'), rect('c'), group('g1', ['a', 'g2']), group('g2', ['b'])],
  ['g1', 'c']
);
const ROWS = buildLayerRows(NESTED, new Set());

/** Vertical offset inside a row that lands in the given zone. */
const BEFORE = 2;
const INTO = 16;
const AFTER = 30;

describe('zoneAt', () => {
  it('splits a group row into before / into / after', () => {
    expect(zoneAt(2, 32, true)).toBe('before');
    expect(zoneAt(16, 32, true)).toBe('into');
    expect(zoneAt(30, 32, true)).toBe('after');
  });

  it('has no into zone for a leaf row', () => {
    // Half a leaf row means "after it", not "inside it" - a leaf has no inside.
    expect(zoneAt(16, 32, false)).toBe('after');
    expect(zoneAt(2, 32, false)).toBe('before');
  });

  it("splits a leaf 50/50 at its own midpoint, not at a group's quarter edge", () => {
    // A leaf at a level boundary is the only way to reach "root order, beside
    // this group" from the side away from the group - a quarter-height edge
    // would leave that target an 8px strip at the default row height, half of
    // what the group's own bottom quarter gets for the same decision.
    expect(zoneAt(15, 32, false)).toBe('before');
    expect(zoneAt(16, 32, false)).toBe('after');
  });
});

describe('resolveDrop', () => {
  it('maps the top of the list to the end of the order', () => {
    // The inversion that is easiest to get wrong: rows run top-first, sibling
    // lists run bottom-to-top, so "above the topmost row" is "past the last id".
    expect(resolveDrop(ROWS, 0, 'before')).toEqual({ parentId: null, index: 2 });
  });

  it('maps the bottom of the list to the start of the order', () => {
    expect(resolveDrop(ROWS, 1, 'after')).toEqual({ parentId: null, index: 0 });
  });

  it('maps both ends of a nested list the same way', () => {
    // g1's members display as g2 then a; its childIds are ['a', 'g2'].
    expect(resolveDrop(ROWS, 2, 'before')).toEqual({ parentId: 'g1', index: 2 });
    expect(resolveDrop(ROWS, 4, 'after')).toEqual({ parentId: 'g1', index: 0 });
  });

  it('sends an into drop to the end of the target group, which is its visual top', () => {
    expect(resolveDrop(ROWS, 1, 'into')).toEqual({
      parentId: 'g1',
      index: Number.MAX_SAFE_INTEGER,
    });
  });

  it('has nothing to say about a row index that does not exist', () => {
    expect(resolveDrop(ROWS, 9, 'before')).toBeNull();
  });
});

describe('planDrop', () => {
  // Row indices, per the layout above: c=0, g1=1, g2=2, b=3, a=4. `fromIndex`
  // is resolved once at drag start (the row's own display index) and passed
  // straight through rather than re-scanned here - see the module doc.
  it('reparents a root row into a group', () => {
    expect(planDrop(ROWS, 'c', 0, 1, INTO, ROW)).toEqual({
      rowIndex: 1,
      zone: 'into',
      parentId: 'g1',
      index: Number.MAX_SAFE_INTEGER,
    });
  });

  it('moves a member within its own group', () => {
    // 'a' is the bottom member; dropping it above g2 puts it on top.
    expect(planDrop(ROWS, 'a', 4, 2, BEFORE, ROW)).toEqual({
      rowIndex: 2,
      zone: 'before',
      parentId: 'g1',
      index: 2,
    });
  });

  it('lifts a member out to the root', () => {
    expect(planDrop(ROWS, 'a', 4, 0, BEFORE, ROW)).toEqual({
      rowIndex: 0,
      zone: 'before',
      parentId: null,
      index: 2,
    });
  });

  it('refuses to drop a group into its own descendant', () => {
    // Otherwise the tree stops being a tree and every recursive walk hangs.
    expect(planDrop(ROWS, 'g1', 1, 2, INTO, ROW)).toBeNull();
    // The same refusal for a row merely *inside* the dragged subtree: its
    // parent is a descendant of the thing being dragged.
    expect(planDrop(ROWS, 'g1', 1, 3, AFTER, ROW)).toBeNull();
    expect(planDrop(ROWS, 'g1', 1, 4, BEFORE, ROW)).toBeNull();
  });

  it('refuses to drop a row inside itself', () => {
    expect(planDrop(ROWS, 'g1', 1, 1, INTO, ROW)).toBeNull();
  });

  it('refuses a drop that puts the row back where it already is', () => {
    // No move, no undo entry. Both edges of the row it started on.
    expect(planDrop(ROWS, 'c', 0, 0, BEFORE, ROW)).toBeNull();
    expect(planDrop(ROWS, 'c', 0, 0, AFTER, ROW)).toBeNull();
    // And the gap it already occupies, expressed from the neighbouring row.
    expect(planDrop(ROWS, 'a', 4, 2, AFTER, ROW)).toBeNull();
  });

  it('refuses an into drop on the group the row already tops', () => {
    expect(planDrop(ROWS, 'b', 3, 2, INTO, ROW)).toBeNull();
  });

  it('offers an into drop on a collapsed group, whose members have no rows', () => {
    const collapsed = buildLayerRows(NESTED, new Set(['g1']));
    expect(collapsed.map((row) => row.id)).toEqual(['c', 'g1']);
    expect(planDrop(collapsed, 'c', 0, 1, INTO, ROW)).toMatchObject({
      zone: 'into',
      parentId: 'g1',
    });
  });

  it('has nothing to say about a row the drag does not know', () => {
    // A stale `fromIndex` - the id at that row is not the one being dragged -
    // is refused exactly like the old `findIndex === -1` case was.
    expect(planDrop(ROWS, 'gone', 0, 0, BEFORE, ROW)).toBeNull();
    expect(planDrop(ROWS, 'c', 0, 9, BEFORE, ROW)).toBeNull();
  });
});
