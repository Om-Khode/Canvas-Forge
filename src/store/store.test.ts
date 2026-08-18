/**
 * Integration tests over the composed store.
 *
 * These exercise the wiring the unit tests can't see: that elements-slice
 * actions really do funnel through history, that selection really is invisible
 * to it, and that structural sharing survives the trip through Zustand.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_LIMIT } from '@/constants';
import { createEllipse, createGroup, createRectangle } from '@/features/elements/factory';
import { translateElements } from '@/features/elements/operations';
import { selectionBounds } from '@/features/selection/bounds';
import { gestureTargets, isGestureLocked } from '@/features/selection/gestureTargets';
import { transformSet } from '@/features/selection/resolve';
import {
  resetCanvasStore,
  selectCanRedo,
  selectCanUndo,
  selectIsTransactionOpen,
  selectRedoLabel,
  selectUndoLabel,
  useCanvasStore,
} from '@/store/index';
import type { CanvasElement, ElementStore, GroupElement } from '@/types';
import { screenPoint, worldRect } from '@/utils/coords';

const store = useCanvasStore;
const state = () => store.getState();

function makeRect(x = 0, y = 0, size = 10): CanvasElement {
  return createRectangle(worldRect(x, y, size, size));
}

beforeEach(() => {
  resetCanvasStore();
});

describe('document actions', () => {
  it('adds elements to the map and the paint order', () => {
    const a = makeRect();
    const b = makeRect(50);
    state().addElement(a);
    state().addElement(b);

    expect(state().elements.order).toEqual([a.id, b.id]);
    expect(state().elements.byId[a.id]).toBe(a);
  });

  it('patches an element without touching the others', () => {
    const a = makeRect();
    const b = makeRect(50);
    state().addElements([a, b]);
    const before = state().elements.byId;

    state().updateElement(a.id, { x: 99 });

    expect(state().elements.byId[a.id]?.x).toBe(99);
    // Structural sharing: the untouched element is the *same object*, which is
    // what makes a history snapshot cost pointers rather than clones.
    expect(state().elements.byId[b.id]).toBe(before[b.id]);
    expect(state().elements.byId).not.toBe(before);
  });

  it('treats a patch that changes nothing as a no-op all the way down', () => {
    const a = makeRect();
    state().addElement(a);
    const before = state().elements;
    const depth = state().history.past.length;

    state().updateElement(a.id, { x: a.x });

    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(depth);
  });

  it('removes elements from both the map and the order', () => {
    const a = makeRect();
    const b = makeRect(50);
    state().addElements([a, b]);
    state().removeElements([a.id]);

    expect(state().elements.order).toEqual([b.id]);
    expect(state().elements.byId[a.id]).toBeUndefined();
  });

  it('does not record an undo entry for deleting an id that does not exist', () => {
    const a = makeRect();
    state().addElement(a);
    const depth = state().history.past.length;

    state().removeElements(['nope']);

    expect(state().history.past).toHaveLength(depth);
  });

  it('applies a patch map from the operations layer', () => {
    const a = makeRect();
    const b = makeRect(50);
    state().addElements([a, b]);

    state().applyPatches(translateElements([a, b], 5, -5), 'Move 2 elements');

    expect(state().elements.byId[a.id]?.x).toBe(5);
    expect(state().elements.byId[b.id]?.y).toBe(-5);
    expect(selectUndoLabel(state())).toBe('Move 2 elements');
  });

  it('reorders layers without producing new element objects', () => {
    const a = makeRect();
    const b = makeRect(50);
    state().addElements([a, b]);
    const before = state().elements.byId;

    state().bringToFront([a.id]);

    expect(state().elements.order).toEqual([b.id, a.id]);
    expect(state().elements.byId).toBe(before);
  });

  it('does not record a reorder that moves nothing', () => {
    const a = makeRect();
    state().addElement(a);
    const depth = state().history.past.length;
    state().bringForward([a.id]);
    expect(state().history.past).toHaveLength(depth);
  });

  it('does not record an undo entry when an added group dissolves in the same commit', () => {
    // What a paste produces when every member of a copied group failed
    // validation, or the payload was hand-crafted: `cloneElements` yields
    // `childIds: []`, so the group `addElements` inserts is gone again by the
    // time the derive pass settles. A paste that inserted nothing must not
    // cost an undo entry just because it briefly minted a fresh `byId`.
    const a = makeRect();
    state().addElement(a);
    const before = state().elements;
    const depth = state().history.past.length;

    state().addElement(createGroup([]));

    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(depth);
  });

  it('renames, hides, and locks', () => {
    const a = makeRect();
    state().addElement(a);

    state().setElementName(a.id, 'Hero');
    state().toggleVisible(a.id);
    state().toggleLocked(a.id);

    expect(state().elements.byId[a.id]).toMatchObject({
      name: 'Hero',
      visible: false,
      locked: true,
    });
  });
});

describe('group invariants in the store', () => {
  it('re-derives a group box when a child moves', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const group = createGroup([a.id, b.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    });

    // The box is a cache; moving a member must update it.
    state().applyPatches({ [b.id]: { x: 90, y: 90 } });

    const derived = state().elements.byId[group.id];
    expect(derived).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('deletes descendants when a group is removed', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const group = createGroup([a.id]);
    state().replaceDocument({ byId: { [a.id]: a, [group.id]: group }, order: [group.id] });

    state().removeElements([group.id]);

    expect(state().elements.byId[a.id]).toBeUndefined();
    expect(state().elements.order).toEqual([]);
  });

  it('dissolves a group when its last child is deleted', () => {
    // A group with no members is not a thing the UI can represent, so it goes.
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const group = createGroup([a.id]);
    state().replaceDocument({ byId: { [a.id]: a, [group.id]: group }, order: [group.id] });

    state().removeElements([a.id]);

    expect(state().elements.byId[group.id]).toBeUndefined();
    expect(state().elements.order).toEqual([]);
  });

  it('cascades dissolution up the tree', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const inner = createGroup([a.id]);
    const outer = createGroup([inner.id]);
    // Insertion order is the point of this test, not incidental: the derivation
    // walks `byId`, so listing the parent *before* the child means `outer` is
    // judged while `inner` still looks alive. Only a second pass can see that it
    // is not - this is the fixed point, not the single sweep.
    state().replaceDocument({
      byId: { [outer.id]: outer, [inner.id]: inner, [a.id]: a },
      order: [outer.id],
    });

    state().removeElements([a.id]);

    expect(state().elements.byId).toEqual({});
    expect(state().elements.order).toEqual([]);
  });

  it('corrects a stale group box on load, with no edit', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    // The cached box is deliberately wrong - a file saved before a member moved,
    // or hand-edited. Nothing here ever calls applyPatches.
    const group = createGroup([a.id, b.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: { ...group, x: 0, y: 0, width: 1, height: 1 } },
      order: [group.id],
    });

    expect(state().elements.byId[group.id]).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
  });

  it('dissolves an empty group on load, with no edit', () => {
    // Persistence keeps `children: []` for an empty group rather than dropping
    // it, and relies on the store's dissolve rule to clean it up on load.
    const group = createGroup([]);
    state().replaceDocument({ byId: { [group.id]: group }, order: [group.id] });

    expect(state().elements.byId[group.id]).toBeUndefined();
    expect(state().elements.order).toEqual([]);
  });

  it('re-derives only the group that moved', () => {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const other = createRectangle(worldRect(200, 200, 10, 10));
    const group = createGroup([a.id, b.id]);
    const otherGroup = createGroup([other.id]);
    state().replaceDocument({
      byId: {
        [a.id]: a,
        [b.id]: b,
        [other.id]: other,
        [group.id]: group,
        [otherGroup.id]: otherGroup,
      },
      order: [group.id, otherGroup.id],
    });
    // First write settles every box; the assertions below are about the second.
    state().applyPatches({ [b.id]: { x: 90, y: 90 } });
    const before = state().elements.byId;

    state().applyPatches({ [b.id]: { x: 91 } });

    // Structural sharing has to survive derivation: an untouched subtree must
    // still be the same objects, or every drag frame would clone the document.
    expect(state().elements.byId[otherGroup.id]).toBe(before[otherGroup.id]);
    expect(state().elements.byId[other.id]).toBe(before[other.id]);
    expect(state().elements.byId[a.id]).toBe(before[a.id]);
    expect(state().elements.byId[group.id]).toMatchObject({ width: 101 });
  });

  it('keeps the same childIds reference when a drag changes only the box', () => {
    // The case `selectLayerRows` (`components/panels/layerRows.ts`) depends on:
    // its memo compares every group's `childIds` by reference, so a box-only
    // rewrite that reallocates the array anyway would rebuild the layers panel
    // on every pointermove of a grouped drag - the "panel re-renders on every
    // frame" failure structural sharing in this file exists to prevent.
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const group = createGroup([a.id, b.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    });
    // First write settles the box; the reference under test is the one that
    // comes out of that settled state, not the factory's own array.
    const before = state().elements.byId[group.id] as GroupElement;

    state().applyPatches({ [b.id]: { x: 90, y: 90 } });

    const after = state().elements.byId[group.id] as GroupElement;
    // The box did change, so the group element itself is a new object...
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ width: 100, height: 100 });
    // ...but membership did not, so `childIds` must be the very same array.
    expect(after.childIds).toBe(before.childIds);
  });

  it('gives a doubly-claimed child to the group that draws it', () => {
    // Two parents is a state `childIds` can express and nothing rejects: it
    // arrives from a paste whose ids collide, or from a hand-edited file. The
    // first group in document order keeps the child, which is the one the
    // renderer already draws it under.
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const first = createGroup([a.id]);
    const second = createGroup([a.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [first.id]: first, [second.id]: second },
      order: [first.id, second.id],
    });

    expect(state().elements.byId[first.id]).toMatchObject({ childIds: [a.id] });
    // The loser is left with no members at all, so the empty-group rule takes it.
    expect(state().elements.byId[second.id]).toBeUndefined();
  });

  it('takes a group member out of the root order', () => {
    // What `addElements` produces when a pasted group arrives with its members:
    // everything is appended as a root, and only the group really is one.
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const group = createGroup([a.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [group.id]: group },
      order: [group.id, a.id],
    });

    expect(state().elements.order).toEqual([group.id]);
    expect(state().elements.byId[a.id]).toBe(a);
  });
});

describe('group and ungroup', () => {
  function seedPair(): { a: CanvasElement; b: CanvasElement } {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    state().replaceDocument({ byId: { [a.id]: a, [b.id]: b }, order: [a.id, b.id] });
    useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
    return { a, b };
  }

  it('groups and ungroups in one undo entry each', () => {
    const { a, b } = seedPair();

    const groupId = state().group([a.id, b.id]);
    expect(groupId).not.toBeNull();
    expect(state().history.past).toHaveLength(1);

    state().ungroup([groupId ?? '']);
    expect(state().history.past).toHaveLength(2);
    expect(state().elements.order).toEqual([a.id, b.id]);
  });

  it('derives the new group box without moving a member', () => {
    const { a, b } = seedPair();

    const groupId = state().group([a.id, b.id]);

    expect(state().elements.byId[groupId ?? '']).toMatchObject({
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    });
    // The members are the same objects at the same coordinates: grouping is
    // invisible on screen.
    expect(state().elements.byId[a.id]).toBe(a);
    expect(state().elements.byId[b.id]).toBe(b);
  });

  it('records nothing when there is nothing to ungroup', () => {
    const { a } = seedPair();

    state().ungroup([a.id]);

    expect(state().history.past).toHaveLength(0);
  });

  it('undoes a group back to the original order', () => {
    const { a, b } = seedPair();
    state().group([a.id, b.id]);

    state().undo();

    expect(state().elements.order).toEqual([a.id, b.id]);
    expect(state().elements.byId[a.id]).toBe(a);
  });
});

describe('reparent', () => {
  /** g1 contains a and g2; g2 contains b; c sits beside g1 at the root. */
  function seedNested() {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const c = createRectangle(worldRect(80, 0, 10, 10));
    const g2 = createGroup([b.id]);
    const g1 = createGroup([a.id, g2.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [c.id]: c, [g1.id]: g1, [g2.id]: g2 },
      order: [g1.id, c.id],
    });
    useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
    return { a, b, c, g1, g2 };
  }

  it('refuses to drop a group into its own descendant', () => {
    // Otherwise the tree stops being a tree and every recursive walk hangs.
    const { g1, g2 } = seedNested();
    const before = state().elements;

    state().reparent(g1.id, g2.id, 0);

    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(0);
  });

  it('refuses to drop a group into itself', () => {
    const { g1 } = seedNested();
    const before = state().elements;

    state().reparent(g1.id, g1.id, 0);

    expect(state().elements).toBe(before);
  });

  it('moves an id between two lists as one undo entry', () => {
    const { b, c, g2 } = seedNested();

    state().reparent(c.id, g2.id, 0);

    // Left one home and joined the other, in a single transaction - a document
    // that had done only half of that would be corrupt.
    expect(state().elements.order).not.toContain(c.id);
    expect(state().elements.byId[g2.id]).toMatchObject({ childIds: [c.id, b.id] });
    expect(state().history.past).toHaveLength(1);
  });

  it('treats an index past the end as the end of the list', () => {
    const { a, c, g1 } = seedNested();

    state().reparent(c.id, g1.id, Number.MAX_SAFE_INTEGER);

    const childIds = (state().elements.byId[g1.id] as GroupElement).childIds;
    expect(childIds[0]).toBe(a.id);
    expect(childIds[childIds.length - 1]).toBe(c.id);
  });

  it('records nothing when the row would not move', () => {
    const { c } = seedNested();
    const before = state().elements;

    // `index` counts the list with the id still in it, so both of these name
    // the slot `c` already occupies.
    state().reparent(c.id, null, 1);
    state().reparent(c.id, null, 2);

    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(0);
  });

  it('dissolves a group whose last member is dragged out', () => {
    const { b, g2 } = seedNested();

    state().reparent(b.id, null, 0);

    expect(state().elements.byId[g2.id]).toBeUndefined();
    expect(state().elements.order).toContain(b.id);
    expect(state().history.past).toHaveLength(1);
  });

  it('undoes the whole move, both lists at once', () => {
    const { c, g2 } = seedNested();
    const before = state().elements;

    state().reparent(c.id, g2.id, 0);
    state().undo();

    expect(state().elements.order).toEqual(before.order);
    expect(state().elements.byId[g2.id]).toBe(before.byId[g2.id]);
  });

  it('ignores an id or a parent that is not there', () => {
    const { c } = seedNested();
    const before = state().elements;

    state().reparent('gone', null, 0);
    state().reparent(c.id, 'gone', 0);
    // A leaf is not a container; nesting into one would strand the child.
    state().reparent(c.id, c.id, 0);

    expect(state().elements).toBe(before);
  });
});

describe('history through the store', () => {
  it('collapses a drag into exactly one undo entry', () => {
    const a = makeRect();
    state().addElement(a);
    const entriesBefore = state().history.past.length;

    state().beginTransaction('Move 1 element');
    for (let frame = 1; frame <= 60; frame++) {
      state().updateElement(a.id, { x: frame });
    }
    expect(selectIsTransactionOpen(state())).toBe(true);
    state().commitTransaction();

    expect(state().history.past).toHaveLength(entriesBefore + 1);
    expect(state().elements.byId[a.id]?.x).toBe(60);
    expect(selectUndoLabel(state())).toBe('Move 1 element');

    state().undo();
    expect(state().elements.byId[a.id]?.x).toBe(0);
  });

  it('records nothing for a click that moved nothing', () => {
    state().addElement(makeRect());
    const entries = state().history.past.length;

    state().beginTransaction('Move 1 element');
    state().commitTransaction();

    expect(state().history.past).toHaveLength(entries);
  });

  it('restores the opening snapshot on abort - Escape during a drag', () => {
    const a = makeRect();
    state().addElement(a);
    const document: ElementStore = state().elements;

    state().beginTransaction('Move 1 element');
    state().updateElement(a.id, { x: 500 });
    state().updateElement(a.id, { y: 500 });
    state().abortTransaction();

    expect(state().elements).toBe(document);
    expect(selectIsTransactionOpen(state())).toBe(false);
  });

  it('round-trips undo and redo, labels included', () => {
    const a = makeRect();
    state().addElement(a);
    state().updateElement(a.id, { x: 10 }, 'Move element');
    state().updateElement(a.id, { x: 20 }, 'Move element again');

    state().undo();
    state().undo();
    expect(state().elements.byId[a.id]?.x).toBe(0);
    expect(selectRedoLabel(state())).toBe('Move element');

    state().redo();
    expect(state().elements.byId[a.id]?.x).toBe(10);
    state().redo();
    expect(state().elements.byId[a.id]?.x).toBe(20);
    expect(selectCanRedo(state())).toBe(false);
  });

  it('undoes an add by removing the element again', () => {
    const a = makeRect();
    state().addElement(a);
    state().undo();

    expect(state().elements.order).toHaveLength(0);
    expect(selectCanUndo(state())).toBe(false);
  });

  it('drops the oldest entries once the cap is reached', () => {
    const a = makeRect();
    state().addElement(a);
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++) {
      state().updateElement(a.id, { x: i }, `Move to ${i}`);
    }

    expect(state().history.past).toHaveLength(HISTORY_LIMIT);
    // The very first entry - the "Add" - has been pushed off the bottom.
    expect(state().history.past[0]?.label).not.toBe(`Add ${a.name}`);
  });

  it('clears history when a project is loaded', () => {
    state().addElement(makeRect());

    const loaded: ElementStore = { byId: {}, order: [] };
    state().replaceDocument(loaded);

    expect(state().elements).toBe(loaded);
    expect(selectCanUndo(state())).toBe(false);
    expect(selectCanRedo(state())).toBe(false);
  });

  it('composes nested transactions into one entry', () => {
    const a = makeRect();
    const b = makeRect(50);
    state().addElements([a, b]);
    const entries = state().history.past.length;

    state().beginTransaction('Align 2 elements');
    state().beginTransaction('Move element');
    state().updateElement(a.id, { x: 1 });
    state().commitTransaction();
    state().updateElement(b.id, { x: 1 });
    state().commitTransaction();

    expect(state().history.past).toHaveLength(entries + 1);
    expect(selectUndoLabel(state())).toBe('Align 2 elements');
  });
});

describe('selection', () => {
  it('is not recorded in history', () => {
    const a = makeRect();
    state().addElement(a);
    const entries = state().history.past.length;

    state().select([a.id]);
    state().toggle(a.id);
    state().selectAll();
    state().clearSelection();

    expect(state().history.past).toHaveLength(entries);
  });

  it('skips hidden elements', () => {
    const visible = makeRect();
    const hidden = makeRect(50);
    state().addElements([visible, hidden]);
    state().toggleVisible(hidden.id);

    state().selectAll();
    expect([...state().selection]).toEqual([visible.id]);

    state().select([hidden.id]);
    expect(state().selection.size).toBe(0);
  });

  it('toggles one id in and out', () => {
    const a = makeRect();
    state().addElement(a);
    state().toggle(a.id);
    expect(state().selection.has(a.id)).toBe(true);
    state().toggle(a.id);
    expect(state().selection.has(a.id)).toBe(false);
  });

  it('keeps the same Set reference when the outcome is identical', () => {
    const a = makeRect();
    state().addElement(a);
    state().select([a.id]);
    const selection = state().selection;
    state().select([a.id]);
    expect(state().selection).toBe(selection);
  });

  it('is pruned when undo or a delete removes the selected element', () => {
    const a = makeRect();
    state().addElement(a);
    state().select([a.id]);

    state().removeElements([a.id]);
    expect(state().selection.size).toBe(0);

    state().undo();
    expect(state().elements.order).toEqual([a.id]);
    // The element is back but not re-selected: history owns the document, not
    // the view state layered over it.
    expect(state().selection.size).toBe(0);
  });
});

describe('selection invariant: no id nested inside another', () => {
  // g1
  //  ├── a
  //  └── g2
  //       └── b
  function seedNested(): { a: CanvasElement; b: CanvasElement; g1: string; g2: string } {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const g2 = createGroup([b.id]);
    const g1 = createGroup([a.id, g2.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [g2.id]: g2, [g1.id]: g1 },
      order: [g1.id],
    });
    return { a, b, g1: g1.id, g2: g2.id };
  }

  it('drops an already-selected descendant when its ancestor is added', () => {
    // The reachable sequence from the review: enter g1, select member a,
    // leave without clearing, then shift-select g1 itself at the top level.
    // Reduced here to the two slice calls that matter - a resolved click on
    // the group ends up calling `toggle('g1')` while `a` is still selected.
    const { a, g1 } = seedNested();
    state().select([a.id]);
    expect([...state().selection]).toEqual([a.id]);

    state().toggle(g1);

    // g1 is an ancestor of a: the coarser selection wins and the descendant
    // does not survive alongside it.
    expect([...state().selection]).toEqual([g1]);
  });

  it('is a no-op to add a descendant of an already-selected ancestor', () => {
    const { a, g1 } = seedNested();
    state().select([g1]);

    state().addToSelection([a.id]);

    // The ancestor already covers the member; adding the member does not
    // narrow the selection down to it.
    expect([...state().selection]).toEqual([g1]);
  });

  it('holds regardless of which id in a single call "arrived" second', () => {
    // select() builds one fresh set - there is no first-vs-second here - so
    // the invariant has to come out the same way from a single call too.
    const { b, g2 } = seedNested();
    state().select([b.id, g2]);
    expect([...state().selection]).toEqual([g2]);
  });

  it('drops a doubly-nested descendant when the outermost ancestor is selected', () => {
    // b sits two levels under g1 (via g2). Selecting the outermost group must
    // still catch it, not just an immediate parent.
    const { b, g1 } = seedNested();
    state().select([b.id]);
    state().toggle(g1);
    expect([...state().selection]).toEqual([g1]);
  });

  // Validity is a property of the (selection, document) *pair*, not of the
  // selection alone - so guarding only the selection writes is not enough. A
  // document mutation can create the ancestor relationship underneath a
  // selection that never changes, and these are the two reachable routes.
  it('re-establishes itself when a reparent nests a selected id under another', () => {
    const loose = createRectangle(worldRect(80, 80, 10, 10));
    const { g1 } = seedNested();
    state().addElements([loose]);
    state().select([g1, loose.id]);
    expect(state().selection.size).toBe(2);

    state().reparent(loose.id, g1, 0);

    // Nothing wrote to the selection here; the document moved underneath it.
    expect([...state().selection]).toEqual([g1]);
  });

  it('re-establishes itself across undo and redo of a reparent', () => {
    const loose = createRectangle(worldRect(80, 80, 10, 10));
    const { g1 } = seedNested();
    state().addElements([loose]);
    state().reparent(loose.id, g1, 0);
    // Selecting both is legal again once the undo has pulled `loose` back out
    // to the root - and illegal again the moment the redo puts it back.
    state().undo();
    state().select([g1, loose.id]);
    expect(state().selection.size).toBe(2);

    state().redo();
    expect([...state().selection]).toEqual([g1]);
  });

  it('leaves an untouched selection reference-identical', () => {
    // The guard runs on every commit, including every frame of a drag. A fresh
    // Set per write would re-render every subscriber that only watches
    // selection, which is the cost this invariant must not have.
    const { a, b } = seedNested();
    const loose = createRectangle(worldRect(80, 80, 10, 10));
    state().addElements([loose]);
    state().select([loose.id]);
    const before = state().selection;

    state().applyPatches({ [a.id]: { x: 5 }, [b.id]: { x: 5 } }, 'Move');

    expect(state().selection).toBe(before);
  });
});

describe('viewport', () => {
  it('pans by a screen delta', () => {
    state().panBy(10, -20);
    expect(state().viewport).toMatchObject({ panX: 10, panY: -20 });
  });

  it('zooms about the cursor, holding the world point under it fixed', () => {
    state().setViewport({ panX: 0, panY: 0, zoom: 1 });
    const cursor = screenPoint(100, 100);
    state().zoomAtCursor(cursor, 2);

    const { panX, panY, zoom } = state().viewport;
    expect(zoom).toBe(2);
    // worldToScreen(anchorWorld=(100,100)) must still be (100,100).
    expect(100 * zoom + panX).toBeCloseTo(100);
    expect(100 * zoom + panY).toBeCloseTo(100);
  });

  it('walks the discrete zoom steps', () => {
    state().setViewportSize(800, 600);
    state().setViewport({ panX: 0, panY: 0, zoom: 1 });
    state().zoomToStep('in');
    expect(state().viewport.zoom).toBe(1.5);
    state().zoomToStep('out');
    expect(state().viewport.zoom).toBe(1);
  });

  it('fits content into the given screen size', () => {
    state().zoomToFit({ x: 0, y: 0, width: 100, height: 100 }, { width: 800, height: 600 });
    expect(state().viewport.zoom).toBeGreaterThan(1);
    // Content centre (50,50) must land in the middle of the 800x600 viewport.
    const { panX, zoom } = state().viewport;
    expect(50 * zoom + panX).toBeCloseTo(400);
  });

  it('resets to the origin centred at 100%', () => {
    state().resetView({ width: 800, height: 600 });
    expect(state().viewport).toEqual({ panX: 400, panY: 300, zoom: 1 });
  });

  it('is not recorded in history', () => {
    state().addElement(makeRect());
    const entries = state().history.past.length;
    state().panBy(5, 5);
    state().zoomAtCursor(screenPoint(0, 0), 2);
    expect(state().history.past).toHaveLength(entries);
  });
});

describe('tool and ui slices', () => {
  it('resets the interaction state when the tool changes', () => {
    state().setInteraction({ kind: 'editing-text', elementId: 'x' });
    state().setTool('ellipse');
    expect(state().interaction).toEqual({ kind: 'idle' });
    expect(state().tool).toBe('ellipse');
  });

  it('keeps a separate default style per tool', () => {
    state().setDefaultStyle('rectangle', { fill: '#ff0000' });
    expect(state().defaultStyles.rectangle.fill).toBe('#ff0000');
    expect(state().defaultStyles.ellipse.fill).not.toBe('#ff0000');
  });

  it('feeds the active style into a factory', () => {
    state().setDefaultStyle('ellipse', { fill: '#00ff00' });
    const ellipse = createEllipse(worldRect(0, 0, 10, 10), {
      style: state().defaultStyles.ellipse,
    });
    expect(ellipse.fill).toBe('#00ff00');
  });

  it('tracks panels, dialogs, save status, and the project name', () => {
    state().togglePanel('minimap');
    expect(state().panels.minimap).toBe(true);

    state().openDialog('export');
    expect(state().activeDialog).toBe('export');
    state().closeDialog();
    expect(state().activeDialog).toBeNull();

    state().setSaveStatus('saving');
    expect(state().saveStatus).toBe('saving');

    state().setProjectName('x'.repeat(500));
    expect(state().projectName.length).toBeLessThanOrEqual(80);
  });

  it('drops collapsed-group state on project load, the same as entering a group', () => {
    // `collapsedGroupIds` is view state about the outgoing document, exactly
    // like `enteredGroupId` - carrying it forward would fold groups in the
    // next project that it never named, and grow the set for the rest of the
    // session. `apply()` clears both; this pins the one this task added.
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const group = createGroup([a.id]);
    state().replaceDocument({ byId: { [a.id]: a, [group.id]: group }, order: [group.id] });
    state().toggleGroupCollapsed(group.id);
    expect(state().collapsedGroupIds.size).toBe(1);

    state().clearCollapsedGroups();

    expect(state().collapsedGroupIds.size).toBe(0);
    // Never in history - collapsing is view state, and clearing it must not
    // add an undo entry either.
    expect(state().history.past).toHaveLength(0);
  });

  it('has no theme field - theming is the useTheme hook’s job', () => {
    expect(state()).not.toHaveProperty('theme');
  });
});

describe('transforming a group', () => {
  /**
   * The central claim of the design: a group transform *is* a multi-selection
   * transform. If these two ever diverge, one of them is wrong.
   */
  it('produces the same patches as transforming its leaves', () => {
    const a = makeRect(0, 0);
    const b = makeRect(40, 40);
    const group = createGroup([a.id, b.id]);
    const document: ElementStore = {
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    };

    state().replaceDocument(document);
    const viaGroup = translateElements(
      gestureTargets(state().elements, [group.id]),
      7,
      11
    );
    const viaLeaves = translateElements([a, b], 7, 11);

    expect(viaGroup).toEqual(viaLeaves);
  });

  it('moves the members, not the derived box', () => {
    // The bug this closes: patching the group's own box was recomputed away by
    // `withDerivedGroups` inside the same write, so the drag moved nothing.
    const a = makeRect(0, 0);
    const b = makeRect(40, 40);
    const group = createGroup([a.id, b.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    });

    state().applyPatches(translateElements(gestureTargets(state().elements, [group.id]), 7, 11));

    expect(state().elements.byId[a.id]?.x).toBe(7);
    expect(state().elements.byId[b.id]?.x).toBe(47);
    // The box followed its members rather than being written directly.
    expect(state().elements.byId[group.id]?.x).toBe(7);
  });

  it('leaves a locked member behind', () => {
    // A locked element is not pickable, but its unlocked sibling resolves to
    // the parent group - which is the one path that could drag it anyway.
    const a: CanvasElement = { ...makeRect(0, 0), locked: true };
    const b = makeRect(40, 40);
    const group = createGroup([a.id, b.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    });

    const targets = gestureTargets(state().elements, [group.id]);

    expect(targets.map((element) => element.id)).toEqual([b.id]);
    expect(isGestureLocked(state().elements, new Set([group.id]))).toBe(false);
  });

  it('reports a group whose members are all locked as locked', () => {
    // `group.locked` is false here; reading it would draw handles the machine
    // then refuses to act on.
    const a: CanvasElement = { ...makeRect(0, 0), locked: true };
    const b: CanvasElement = { ...makeRect(40, 40), locked: true };
    const group = createGroup([a.id, b.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    });

    expect(state().elements.byId[group.id]?.locked).toBe(false);
    expect(isGestureLocked(state().elements, new Set([group.id]))).toBe(true);
  });

  it('does not transform an element twice when a group and its child are both named', () => {
    // `leavesOf` shares one visited set across the whole call, so a selection
    // holding both a group and a member of it still emits that member once.
    const a = makeRect(0, 0);
    const b = makeRect(40, 40);
    const group = createGroup([a.id, b.id]);
    state().replaceDocument({
      byId: { [a.id]: a, [b.id]: b, [group.id]: group },
      order: [group.id],
    });

    const targets = gestureTargets(state().elements, [group.id, a.id]);

    expect(targets.map((element) => element.id)).toEqual([a.id, b.id]);
  });

  it('leaves a locked member behind in a flat, ungrouped selection too', () => {
    // Task 6's report claimed the ungrouped path was "byte-identical to
    // before" - false: `selectSelectedElements` never filtered locks, so a
    // locked element in a flat multi-selection used to be dragged along.
    // `gestureTargets` is now the transform path's snapshot regardless of
    // whether the selection contains a group, so this is a real, if probably
    // correct, behaviour change and needed its own coverage (review round-1
    // finding 1).
    const a: CanvasElement = { ...makeRect(0, 0), locked: true };
    const b = makeRect(40, 40);
    state().replaceDocument({ byId: { [a.id]: a, [b.id]: b }, order: [a.id, b.id] });

    const targets = gestureTargets(state().elements, [a.id, b.id]);

    expect(targets.map((element) => element.id)).toEqual([b.id]);
  });

  describe('resize frame - bounds agree with what is drawn and hit-tested', () => {
    /**
     * Review round-1 finding 1: `usePointerInteraction.probeUnderPointer` and
     * `executeIntents.beginTransaction` must measure the same box, or a
     * resize's pointer offset is read against a different frame than the one
     * the user grabbed a handle on. Both now read `transformSet`, unfiltered
     * by lock - these are the three shapes the review named as reachable
     * divergences under the old, differently-filtered pair. The actual
     * resize math for the lock-mixed shapes is exercised end to end in
     * `executeIntents.test.ts`, which is the level that bug actually lived
     * at (calling `resizeElements` on a pre-filtered array here would repeat
     * the shortcut that caused it).
     */
    it('a single-leaf group frames on that leaf’s own rect, not the group’s cached box', () => {
      // Reachable via `deriveGroups`: a group stays alive while any child is
      // still live, so grouping three and deleting two leaves exactly one.
      const a = makeRect(0, 0, 10);
      const group = createGroup([a.id]);
      state().replaceDocument({ byId: { [a.id]: a, [group.id]: group }, order: [group.id] });

      const bounds = selectionBounds(transformSet(state().elements, [group.id]));
      if (bounds.kind !== 'single') throw new Error('expected single');
      expect(bounds).toMatchObject({ id: a.id, rect: { x: 0, y: 0, width: 10, height: 10 } });
    });

    it('a group with one locked member still frames on the full union', () => {
      const a: CanvasElement = { ...makeRect(0, 0, 10), locked: true };
      const b = makeRect(40, 40, 10);
      const group = createGroup([a.id, b.id]);
      state().replaceDocument({
        byId: { [a.id]: a, [b.id]: b, [group.id]: group },
        order: [group.id],
      });

      const bounds = selectionBounds(transformSet(state().elements, [group.id]));
      if (bounds.kind !== 'multiple') throw new Error('expected multiple');
      // The frame spans both members, matching what a locked selection still
      // shows on screen (see `elementsToPaint`) - not just the unlocked one,
      // and not the group's own cached box read as a single element either.
      expect(bounds.rect).toEqual({ x: 0, y: 0, width: 50, height: 50 });
      expect(gestureTargets(state().elements, [group.id]).map((e) => e.id)).toEqual([b.id]);
    });

    it('a flat selection with one locked element still frames on the full selection', () => {
      const a: CanvasElement = { ...makeRect(0, 0, 10), locked: true };
      const b = makeRect(40, 40, 10);
      const c = makeRect(0, 40, 10);
      state().replaceDocument({
        byId: { [a.id]: a, [b.id]: b, [c.id]: c },
        order: [a.id, b.id, c.id],
      });

      const bounds = selectionBounds(transformSet(state().elements, [a.id, b.id, c.id]));
      if (bounds.kind !== 'multiple') throw new Error('expected multiple');
      expect(bounds.rect).toEqual({ x: 0, y: 0, width: 50, height: 50 });
      expect(gestureTargets(state().elements, [a.id, b.id, c.id]).map((e) => e.id)).toEqual([
        b.id,
        c.id,
      ]);
    });
  });
});
