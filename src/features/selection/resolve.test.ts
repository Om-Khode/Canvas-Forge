import { describe, expect, it } from 'vitest';
import {
  descendTarget,
  pointerEligibility,
  resolveSelectionTarget,
  resolveSelectionTargets,
  transformSet,
} from './resolve';
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

function group(
  id: string,
  childIds: string[],
  overrides: Partial<GroupElement> = {}
): GroupElement {
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
    group('g2', ['b']),
    rect('b', 40, 40),
    rect('c', 100, 100),
  ],
  ['g1', 'c']
);

describe('resolveSelectionTarget', () => {
  it('selects the outermost group when nothing has been entered', () => {
    expect(resolveSelectionTarget(NESTED, 'b', null)).toBe('g1');
  });

  it('selects the child inside the group that has been entered', () => {
    // Having descended into g1, clicking b selects g2 - one level down, not the leaf.
    expect(resolveSelectionTarget(NESTED, 'b', 'g1')).toBe('g2');
  });

  it('selects the leaf when its immediate parent has been entered', () => {
    expect(resolveSelectionTarget(NESTED, 'b', 'g2')).toBe('b');
  });

  it('returns the id itself for a loose element', () => {
    expect(resolveSelectionTarget(NESTED, 'c', null)).toBe('c');
  });

  it('falls back to the outermost group for a click outside the entered one', () => {
    // c is not in g2, so clicking it behaves as if the group had been left.
    expect(resolveSelectionTarget(NESTED, 'c', 'g2')).toBe('c');
    expect(resolveSelectionTarget(NESTED, 'a', 'g2')).toBe('g1');
  });

  it('ignores an entered group that no longer exists', () => {
    // The group was ungrouped or deleted while it was entered. A stale id must
    // degrade to the top level, not wedge every subsequent click.
    expect(resolveSelectionTarget(NESTED, 'b', 'gone')).toBe('g1');
  });

  it('is idempotent, so re-selecting a resolved id changes nothing', () => {
    // `executeIntents` re-resolves ids that may already have been resolved once;
    // that is only safe because a second pass is a no-op.
    for (const entered of [null, 'g1', 'g2'] as const) {
      for (const hit of ['a', 'b', 'c']) {
        const once = resolveSelectionTarget(NESTED, hit, entered);
        expect(resolveSelectionTarget(NESTED, once, entered)).toBe(once);
      }
    }
  });
});

describe('resolveSelectionTargets', () => {
  it('collapses every member of a group onto the group itself', () => {
    expect(resolveSelectionTargets(NESTED, ['a', 'b', 'c'], null)).toEqual(['g1', 'c']);
  });

  it('resolves one level down inside the entered group', () => {
    expect(resolveSelectionTargets(NESTED, ['a', 'b'], 'g1')).toEqual(['a', 'g2']);
  });
});

describe('descendTarget', () => {
  it('enters the outermost group first', () => {
    expect(descendTarget(NESTED, 'b', null)).toBe('g1');
  });

  it('enters the next group down once inside', () => {
    expect(descendTarget(NESTED, 'b', 'g1')).toBe('g2');
  });

  it('has nothing to enter once the leaf is directly selectable', () => {
    expect(descendTarget(NESTED, 'b', 'g2')).toBeNull();
    expect(descendTarget(NESTED, 'c', null)).toBeNull();
  });
});

describe('transformSet', () => {
  it('expands groups to their leaves', () => {
    expect(transformSet(NESTED, ['g1']).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('passes loose elements through', () => {
    expect(transformSet(NESTED, ['c']).map((e) => e.id)).toEqual(['c']);
  });

  it('emits an element once when it is named both directly and through its group', () => {
    expect(transformSet(NESTED, ['g1', 'a']).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('pointerEligibility', () => {
  const hidden = store(
    [group('g', ['x'], { visible: false }), rect('x', 0, 0), rect('c', 100, 100)],
    ['g', 'c']
  );
  const locked = store([group('g', ['x'], { locked: true }), rect('x', 0, 0)], ['g']);

  it('refuses a visible member of a hidden group', () => {
    const eligible = pointerEligibility(hidden);
    expect(eligible(hidden.byId['x'] as CanvasElement)).toBe(false);
    expect(eligible(hidden.byId['c'] as CanvasElement)).toBe(true);
  });

  it('refuses an unlocked member of a locked group', () => {
    const eligible = pointerEligibility(locked);
    expect(eligible(locked.byId['x'] as CanvasElement)).toBe(false);
  });

  it('admits members of an ordinary group', () => {
    const eligible = pointerEligibility(NESTED);
    expect(eligible(NESTED.byId['b'] as CanvasElement)).toBe(true);
  });
});
