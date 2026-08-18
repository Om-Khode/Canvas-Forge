/**
 * The executor is the only place an intent becomes a store write, and with
 * groups it is also the only place a leaf id becomes a selected id. That makes
 * it the seam worth testing directly: no DOM, no machine, just "these intents
 * arrived, this is the selection that resulted".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeIntents, type GestureRefs } from './executeIntents';
import type { InteractionIntent } from './protocol';
import { createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store';
import type { CanvasElement, ElementId } from '@/types';
import { worldPoint, worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();

function gestureRefs(): GestureRefs {
  return { snapshot: { current: null }, draftId: { current: null } };
}

function run(...intents: InteractionIntent[]): void {
  executeIntents(intents, gestureRefs());
}

function selection(): ElementId[] {
  return [...state().selection];
}

/*  g1
     ├── a
     └── g2 ── b1, b2        plus loose c at root                            */
let a: CanvasElement;
let b1: CanvasElement;
let b2: CanvasElement;
let c: CanvasElement;
let g1: ElementId;
let g2: ElementId;

/** The store refuses to group fewer than two elements, so the id is never null here. */
function groupOf(ids: readonly ElementId[]): ElementId {
  const id = state().group(ids);
  if (id === null) throw new Error('fixture failed to group');
  return id;
}

beforeEach(() => {
  resetCanvasStore();
  a = createRectangle(worldRect(0, 0, 10, 10));
  b1 = createRectangle(worldRect(40, 40, 10, 10));
  b2 = createRectangle(worldRect(60, 60, 10, 10));
  c = createRectangle(worldRect(100, 100, 10, 10));
  state().addElements([a, b1, b2, c]);

  g2 = groupOf([b1.id, b2.id]);
  g1 = groupOf([a.id, g2]);
});

describe('select', () => {
  it('resolves a leaf to its outermost group', () => {
    run({ kind: 'select', ids: [b1.id] });
    expect(selection()).toEqual([g1]);
  });

  it('leaves a loose element alone', () => {
    run({ kind: 'select', ids: [c.id] });
    expect(selection()).toEqual([c.id]);
  });

  it('collapses two members of the same group onto one id', () => {
    run({ kind: 'select', ids: [a.id, b1.id] });
    expect(selection()).toEqual([g1]);
  });
});

describe('toggleSelect', () => {
  it('adds the group, not the leaf that was shift-clicked', () => {
    run({ kind: 'select', ids: [c.id] }, { kind: 'toggleSelect', id: b1.id });
    expect(selection()).toEqual([c.id, g1]);
  });

  it('removes the group when a second shift-click lands inside it', () => {
    run(
      { kind: 'select', ids: [c.id] },
      { kind: 'toggleSelect', id: b1.id },
      { kind: 'toggleSelect', id: a.id }
    );
    expect(selection()).toEqual([c.id]);
  });
});

describe('enterGroup', () => {
  it('selects one level down once the group has been entered', () => {
    run({ kind: 'enterGroup', groupId: g1 }, { kind: 'select', ids: [b1.id] });
    expect(selection()).toEqual([g2]);
  });

  it('selects the leaf once its immediate parent has been entered', () => {
    run({ kind: 'enterGroup', groupId: g2 }, { kind: 'select', ids: [b1.id] });
    expect(selection()).toEqual([b1.id]);
  });

  it('is the double-click batch: entering and reselecting in one pass', () => {
    // Exactly what the machine emits, and the reason the executor re-reads the
    // store between intents rather than snapshotting it once.
    run({ kind: 'enterGroup', groupId: g1 }, { kind: 'select', ids: [a.id] });
    expect(selection()).toEqual([a.id]);
    expect(state().enteredGroupId).toBe(g1);
  });

  it('returns to the top level', () => {
    run({ kind: 'enterGroup', groupId: g1 }, { kind: 'enterGroup', groupId: null });
    expect(state().enteredGroupId).toBeNull();
    run({ kind: 'select', ids: [b1.id] });
    expect(selection()).toEqual([g1]);
  });

  it('does not wedge selection when the entered group is deleted', () => {
    run({ kind: 'enterGroup', groupId: g2 });
    state().ungroup([g2]);
    run({ kind: 'select', ids: [b1.id] });
    // b's remaining ancestor is g1, and the stale id names nothing, so the click
    // behaves as it would at the top level.
    expect(selection()).toEqual([g1]);
  });

  it('stays out of history', () => {
    const before = state().history;
    run({ kind: 'enterGroup', groupId: g1 });
    expect(state().history).toBe(before);
  });
});

describe('marqueeSelect', () => {
  it('selects the group when the band touches one of its members', () => {
    run({
      kind: 'marqueeSelect',
      rectWorld: worldRect(-5, -5, 20, 20),
      additive: false,
    });
    expect(selection()).toEqual([g1]);
  });

  it('does not name the group twice when the band touches two members', () => {
    run({
      kind: 'marqueeSelect',
      rectWorld: worldRect(-5, -5, 200, 200),
      additive: false,
    });
    // Every one of a, b and c is inside the band; a and b collapse onto g1.
    expect(selection()).toEqual([g1, c.id]);
  });

  it('follows the click rule inside an entered group', () => {
    run(
      { kind: 'enterGroup', groupId: g1 },
      { kind: 'marqueeSelect', rectWorld: worldRect(-5, -5, 200, 200), additive: false }
    );
    expect(selection()).toEqual([a.id, g2, c.id]);
  });

  it('skips members of a hidden group', () => {
    state().toggleVisible(g1);
    run({
      kind: 'marqueeSelect',
      rectWorld: worldRect(-5, -5, 200, 200),
      additive: false,
    });
    expect(selection()).toEqual([c.id]);
  });
});

describe('createDraft', () => {
  it('names the new shape past one that only exists inside a group', () => {
    // Its own document: the shared fixture's rectangles are all called
    // "Rectangle 1", which would make the two walks agree by accident.
    resetCanvasStore();
    const inside1: CanvasElement = {
      ...createRectangle(worldRect(0, 0, 10, 10)),
      name: 'Rectangle 3',
    };
    const inside2: CanvasElement = {
      ...createRectangle(worldRect(20, 20, 10, 10)),
      name: 'Rectangle 4',
    };
    state().addElements([inside1, inside2]);
    groupOf([inside1.id, inside2.id]);
    // The premise: the root order is the group alone, so a root-level walk sees
    // no rectangle at all and would hand the draft the name "Rectangle 1".
    expect(state().elements.order).toHaveLength(1);

    run({
      kind: 'createDraft',
      draft: {
        tool: 'rectangle',
        startWorld: worldPoint(100, 100),
        endWorld: worldPoint(140, 140),
        points: [worldPoint(100, 100), worldPoint(140, 140)],
      },
    });

    const draftId = state().elements.order[1];
    expect(state().elements.byId[draftId!]?.name).toBe('Rectangle 5');
  });
});

/**
 * Review round-1 finding 1. `beginTransaction`'s snapshot has two sets:
 * `elements` (`gestureTargets`, lock filtered - what actually gets patched)
 * and `frameElements` (`transformSet`, unfiltered - the box `resize` computes
 * against). These drive the real `beginTransaction` → `resize` path end to
 * end, rather than calling `resizeElements` directly on a pre-filtered array,
 * because that is exactly the shortcut that produced the bug: filtering
 * before the call, not just measuring the wrong box, is what made a group of
 * two with one locked member resize its surviving leaf as if that leaf alone
 * filled the whole frame.
 */
describe('resize', () => {
  function resizeTo(x: number, y: number): void {
    run(
      { kind: 'beginTransaction', label: 'Resize elements' },
      { kind: 'resize', handle: 'se', pointerWorld: worldPoint(x, y), preserveAspect: false, fromCenter: false }
    );
  }

  it('resizes a group reduced to a single live leaf in that leaf’s own frame', () => {
    // `deriveGroups` keeps a group alive while any child is still live, so
    // grouping three and deleting two leaves exactly one - the group's own
    // cached box and the leaf's own rect coincide here, so this is a sanity
    // check that the split snapshot did not regress the ordinary case.
    const solo = createRectangle(worldRect(0, 0, 10, 10));
    const doomed1 = createRectangle(worldRect(20, 20, 10, 10));
    const doomed2 = createRectangle(worldRect(40, 40, 10, 10));
    state().addElements([solo, doomed1, doomed2]);
    const group = state().group([solo.id, doomed1.id, doomed2.id]);
    if (group === null) throw new Error('fixture failed to group');
    state().removeElements([doomed1.id, doomed2.id]);
    state().select([group]);

    resizeTo(20, 20);

    expect(state().elements.byId[solo.id]).toMatchObject({ width: 20, height: 20 });
  });

  it('scales the surviving leaf in place inside the full frame when a group member is locked', () => {
    const locked = createRectangle(worldRect(0, 0, 10, 10));
    const movable = createRectangle(worldRect(40, 40, 10, 10));
    state().addElements([locked, movable]);
    state().toggleLocked(locked.id);
    const group = state().group([locked.id, movable.id]);
    if (group === null) throw new Error('fixture failed to group');
    state().select([group]);

    // The group's own box spans (0,0)-(50,50); dragging its 'se' corner from
    // (50,50) to (60,60) is a 1.2x scale of that shared frame.
    resizeTo(60, 60);

    expect(state().elements.byId[movable.id]).toMatchObject({
      x: 48,
      y: 48,
      width: 12,
      height: 12,
    });
    // Locked, and therefore untouched - not resized to fill the new frame.
    expect(state().elements.byId[locked.id]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('scales the unlocked members in place inside the full frame in a flat selection too', () => {
    const locked = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const d = createRectangle(worldRect(0, 40, 10, 10));
    state().addElements([locked, b, d]);
    state().toggleLocked(locked.id);
    state().select([locked.id, b.id, d.id]);

    resizeTo(60, 60);

    expect(state().elements.byId[b.id]).toMatchObject({ width: 12, height: 12 });
    expect(state().elements.byId[d.id]).toMatchObject({ width: 12, height: 12 });
    expect(state().elements.byId[locked.id]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });
});
