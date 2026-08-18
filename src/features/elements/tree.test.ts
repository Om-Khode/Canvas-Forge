import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  descendantsOf,
  deriveGroupRect,
  effectiveLocked,
  effectiveVisible,
  elementsInPaintOrder,
  elementsToPaint,
  leavesOf,
  maxDepth,
  outermostAncestor,
  parentOf,
  wouldCreateCycle,
} from './tree';
import type { CanvasElement, ElementStore, GroupElement, RectangleElement } from '@/types';

function rect(id: string, x: number, y: number, w = 10, h = 10): RectangleElement {
  return {
    id,
    type: 'rectangle',
    name: id,
    x,
    y,
    width: w,
    height: h,
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

function group(id: string, childIds: string[], overrides: Partial<GroupElement> = {}): GroupElement {
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
    ...overrides,
  };
}

function store(elements: CanvasElement[], order: string[]): ElementStore {
  return { byId: Object.fromEntries(elements.map((e) => [e.id, e])), order };
}

/*  g1
     ├── a
     └── g2
          └── b        plus loose c at root                                  */
const NESTED = store(
  [
    group('g1', ['a', 'g2']),
    rect('a', 0, 0),
    // g2 carries a deliberately stale cached box, far outside the union of its
    // members. Nothing keeps that cache fresh between a member moving and the
    // store recomputing it, so `deriveGroupRect` must ignore it.
    group('g2', ['b'], { x: 200, y: 200, width: 100, height: 100 }),
    rect('b', 40, 40),
    rect('c', 100, 100),
  ],
  ['g1', 'c']
);

/*  Cycles a real document can contain: `childIds` survives a JSON round trip,
    so a group listing itself and a pair listing each other are both loadable.  */
const SELF_CYCLE = store([group('g', ['g'])], ['g']);
const TWO_CYCLE = store([group('p', ['q']), group('q', ['p'])], ['p']);

describe('parentOf', () => {
  it('finds the containing group', () => {
    expect(parentOf(NESTED, 'a')).toBe('g1');
    expect(parentOf(NESTED, 'b')).toBe('g2');
  });

  it('returns null for a root element', () => {
    expect(parentOf(NESTED, 'g1')).toBeNull();
    expect(parentOf(NESTED, 'c')).toBeNull();
  });
});

describe('ancestorsOf', () => {
  it('lists ancestors nearest first', () => {
    expect(ancestorsOf(NESTED, 'b')).toEqual(['g2', 'g1']);
  });
});

describe('outermostAncestor', () => {
  it('walks to the top of the tree', () => {
    // What a canvas click selects: the whole group, not the leaf inside it.
    expect(outermostAncestor(NESTED, 'b')).toBe('g1');
  });

  it('returns the id itself when it is already a root', () => {
    expect(outermostAncestor(NESTED, 'c')).toBe('c');
  });
});

describe('descendantsOf', () => {
  it('returns the whole subtree, depth first, excluding itself', () => {
    expect(descendantsOf(NESTED, 'g1')).toEqual(['a', 'g2', 'b']);
  });
});

describe('leavesOf', () => {
  it('expands groups to their non-group descendants', () => {
    expect(leavesOf(NESTED, ['g1'])).toEqual(['a', 'b']);
  });

  it('passes plain elements straight through and de-duplicates', () => {
    expect(leavesOf(NESTED, ['g1', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('elementsInPaintOrder', () => {
  it('flattens the tree depth first, bottom to top', () => {
    expect(elementsInPaintOrder(NESTED).map((e) => e.id)).toEqual(['g1', 'a', 'g2', 'b', 'c']);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects putting a group inside its own descendant', () => {
    expect(wouldCreateCycle(NESTED, 'g2', ['g1'])).toBe(true);
  });

  it('rejects putting a group inside itself', () => {
    expect(wouldCreateCycle(NESTED, 'g1', ['g1'])).toBe(true);
  });

  it('allows an unrelated move', () => {
    expect(wouldCreateCycle(NESTED, 'g2', ['c'])).toBe(false);
  });
});

describe('deriveGroupRect', () => {
  it('is the union of descendant boxes', () => {
    // a is 10x10 at (0,0); b is 10x10 at (40,40).
    expect(deriveGroupRect(NESTED, 'g1')).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it('ignores a nested group’s own cached box', () => {
    // g2's cache says (200,200,100x100) and its only member says (40,40,10x10).
    // Counting the cache would drag the union out to 300x300; the members are
    // the truth, and a nested group's box is only ever a copy of them.
    expect(deriveGroupRect(NESTED, 'g2')).toEqual({ x: 40, y: 40, width: 10, height: 10 });
  });

  it('is null for a group with no descendants', () => {
    const empty = store([group('g', [])], ['g']);
    expect(deriveGroupRect(empty, 'g')).toBeNull();
  });
});

describe('effective lock and visibility', () => {
  it('inherits lock from any ancestor', () => {
    const locked = store([group('g1', ['a'], { locked: true }), rect('a', 0, 0)], ['g1']);
    expect(effectiveLocked(locked, 'a')).toBe(true);
  });

  it('inherits hidden from any ancestor', () => {
    const hidden = store([group('g1', ['a'], { visible: false }), rect('a', 0, 0)], ['g1']);
    expect(effectiveVisible(hidden, 'a')).toBe(false);
  });

  it('leaves an element in an unlocked, visible tree alone', () => {
    expect(effectiveLocked(NESTED, 'b')).toBe(false);
    expect(effectiveVisible(NESTED, 'b')).toBe(true);
  });
});

describe('maxDepth', () => {
  it('counts the deepest nesting level, roots being depth 1', () => {
    expect(maxDepth(NESTED)).toBe(3);
  });
});

describe('elementsToPaint', () => {
  it('reaches grouped elements, which root order cannot', () => {
    // The regression this exists for: `order` is root ids only, so building the
    // scene from it made grouping anything erase it from the canvas.
    expect(elementsToPaint(NESTED).map((e) => e.id)).toEqual(['g1', 'a', 'g2', 'b', 'c']);
  });

  it('keeps groups in the list even though they draw nothing', () => {
    // The overlay finds the selected element by scanning this array, so a
    // selected group missing from it would lose its selection frame.
    expect(elementsToPaint(NESTED).some((e) => e.id === 'g1')).toBe(true);
  });

  it('keeps every element of an ungrouped document referentially identical', () => {
    // Structural sharing: a copy per element per frame would be paid by every
    // document, and only a group can make one necessary.
    const flat = store([rect('a', 0, 0), rect('b', 20, 20)], ['a', 'b']);
    const painted = elementsToPaint(flat);
    expect(painted[0]).toBe(flat.byId['a']);
    expect(painted[1]).toBe(flat.byId['b']);
  });

  it('multiplies the opacity of an ancestor into its members', () => {
    const faded = store(
      [group('g', ['a'], { opacity: 0.5 }), rect('a', 0, 0)],
      ['g']
    );
    const a = elementsToPaint(faded).find((e) => e.id === 'a');
    expect(a?.opacity).toBe(0.5);
  });

  it('composes nested group opacity rather than overwriting it', () => {
    const nested = store(
      [
        group('outer', ['inner'], { opacity: 0.5 }),
        group('inner', ['a'], { opacity: 0.5 }),
        { ...rect('a', 0, 0), opacity: 0.5 },
      ],
      ['outer']
    );
    expect(elementsToPaint(nested).find((e) => e.id === 'a')?.opacity).toBe(0.125);
  });

  it('drops a subtree under a hidden group', () => {
    // `visible` on the member says nothing about the group above it, and the
    // engine is handed a flat array with no way to ask.
    const hidden = store(
      [group('g', ['a'], { visible: false }), rect('a', 0, 0), rect('c', 50, 50)],
      ['g', 'c']
    );
    expect(elementsToPaint(hidden).map((e) => e.id)).toEqual(['c']);
  });

  it('reports a group as locked when every member is', () => {
    // Not the group's own flag: without this the overlay draws resize handles
    // on a group it will then refuse to transform.
    const allLocked = store(
      [group('g', ['a', 'b']), { ...rect('a', 0, 0), locked: true }, { ...rect('b', 20, 20), locked: true }],
      ['g']
    );
    expect(elementsToPaint(allLocked).find((e) => e.id === 'g')?.locked).toBe(true);
  });

  it('leaves a group unlocked while one member can still move', () => {
    const partly = store(
      [group('g', ['a', 'b']), { ...rect('a', 0, 0), locked: true }, rect('b', 20, 20)],
      ['g']
    );
    const painted = elementsToPaint(partly);
    expect(painted.find((e) => e.id === 'g')?.locked).toBe(false);
    // The lock is still inherited downwards, which is what the overlay reads.
    expect(painted.find((e) => e.id === 'a')?.locked).toBe(true);
    expect(painted.find((e) => e.id === 'b')?.locked).toBe(false);
  });

  it('inherits a locked group down to its members', () => {
    const locked = store([group('g', ['a'], { locked: true }), rect('a', 0, 0)], ['g']);
    expect(elementsToPaint(locked).find((e) => e.id === 'a')?.locked).toBe(true);
  });

  it('terminates on a cyclic store', () => {
    expect(elementsToPaint(SELF_CYCLE).map((e) => e.id)).toEqual(['g']);
    expect(elementsToPaint(TWO_CYCLE).map((e) => e.id)).toEqual(['p', 'q']);
  });
});

/*
 * Every assertion below would be a `RangeError: Maximum call stack size
 * exceeded` without the visited set - returning a value at all is the property
 * under test, and the exact value is a bonus.
 */
describe('walks terminate on a cyclic store', () => {
  it('survives a group that lists itself', () => {
    expect(descendantsOf(SELF_CYCLE, 'g')).toEqual([]);
    expect(leavesOf(SELF_CYCLE, ['g'])).toEqual([]);
    expect(elementsInPaintOrder(SELF_CYCLE).map((e) => e.id)).toEqual(['g']);
    expect(maxDepth(SELF_CYCLE)).toBe(1);
    expect(ancestorsOf(SELF_CYCLE, 'g')).toEqual([]);
  });

  it('survives two groups that list each other', () => {
    expect(descendantsOf(TWO_CYCLE, 'p')).toEqual(['q']);
    expect(leavesOf(TWO_CYCLE, ['p'])).toEqual([]);
    expect(elementsInPaintOrder(TWO_CYCLE).map((e) => e.id)).toEqual(['p', 'q']);
    expect(maxDepth(TWO_CYCLE)).toBe(2);
    expect(ancestorsOf(TWO_CYCLE, 'p')).toEqual(['q']);
  });

  it('lets wouldCreateCycle answer on a store that is already cyclic', () => {
    // The detector is built on descendantsOf, so before the guard it was the
    // first thing to overflow on exactly the documents it exists to catch.
    expect(wouldCreateCycle(TWO_CYCLE, 'p', ['q'])).toBe(true);
    expect(wouldCreateCycle(SELF_CYCLE, 'g', ['g'])).toBe(true);
  });
});
