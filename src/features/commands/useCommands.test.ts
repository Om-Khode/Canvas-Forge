/**
 * The keyboard, exercised through the real listener.
 *
 * These tests drive `document` events rather than calling the nudger directly,
 * because the nudger is deliberately not exported: what is being checked is the
 * whole path a key press actually takes - install, listener, gesture target
 * resolution, transaction, commit - and a unit test of the private function
 * would have gone on passing through the group defect this file was written for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, renderHook } from '@testing-library/react';

import { useCommands } from './useCommands';
import { createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store';
import type { ElementId, WorldRect } from '@/types';

function rect(x: number, y: number): WorldRect {
  return { x, y, width: 10, height: 10 } as WorldRect;
}

const state = () => useCanvasStore.getState();

/**
 * `useCommands` is reference counted against a module-singleton registry, which
 * throws on a duplicate registration - so every install has to be torn down or
 * the next test in the file fails for the wrong reason.
 */
let teardown: (() => void) | null = null;

function installKeyboard(): void {
  const rendered = renderHook(() => useCommands());
  teardown = () => {
    rendered.unmount();
  };
}

/** Fixture setup is not something a test should have to count or undo past. */
function forgetHistory(): void {
  useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
}

/** One complete nudge gesture: press and release, which is what commits it. */
function nudge(key: string, shiftKey = false): void {
  fireEvent.keyDown(document, { key, shiftKey });
  fireEvent.keyUp(document, { key, shiftKey });
}

function x(id: ElementId): number | undefined {
  return state().elements.byId[id]?.x;
}

beforeEach(() => {
  resetCanvasStore();
});

afterEach(() => {
  teardown?.();
  teardown = null;
});

describe('arrow-key nudging', () => {
  it('moves a plain selection by one unit per press', () => {
    const element = createRectangle(rect(0, 0));
    state().addElements([element]);
    state().select([element.id]);
    forgetHistory();
    installKeyboard();

    nudge('ArrowRight');
    expect(x(element.id)).toBe(1);
  });

  it('moves ten units with Shift held', () => {
    const element = createRectangle(rect(0, 0));
    state().addElements([element]);
    state().select([element.id]);
    forgetHistory();
    installKeyboard();

    nudge('ArrowRight', true);
    expect(x(element.id)).toBe(10);
  });

  it('leaves a locked element where it is', () => {
    const locked = createRectangle(rect(0, 0));
    const loose = createRectangle(rect(20, 0));
    state().addElements([{ ...locked, locked: true }, loose]);
    state().select([locked.id, loose.id]);
    forgetHistory();
    installKeyboard();

    nudge('ArrowRight');
    expect(x(locked.id)).toBe(0);
    expect(x(loose.id)).toBe(21);
  });
});

describe('nudging a group', () => {
  /** Two rectangles in one group, with the group selected. */
  function selectedGroup(): { groupId: ElementId; a: ElementId; b: ElementId } {
    const a = createRectangle(rect(0, 0));
    const b = createRectangle(rect(20, 0));
    state().addElements([a, b]);
    const groupId = state().group([a.id, b.id]);
    if (groupId === null) throw new Error('grouping failed');
    state().select([groupId]);
    forgetHistory();
    return { groupId, a: a.id, b: b.id };
  }

  it('moves the members, not the group’s derived box', () => {
    const { groupId, a, b } = selectedGroup();
    installKeyboard();

    nudge('ArrowRight');

    // The group's x/y are a cache `withDerivedGroups` recomputes from the
    // leaves inside the same synchronous write, so a patch naming the group is
    // erased before anything can observe it - the nudge moved nothing at all
    // until `movable()` was routed through `gestureTargets`.
    expect(x(a)).toBe(1);
    expect(x(b)).toBe(21);
    expect(x(groupId)).toBe(1);
  });

  it('costs exactly one undo entry, which puts the members back', () => {
    const { a, b } = selectedGroup();
    installKeyboard();

    nudge('ArrowRight');

    // The second half of the same defect: the erased patch still recorded an
    // entry, because the derive pass mints a fresh group object with identical
    // content and history's guard compares by reference. So "one entry" alone
    // was already true of the broken version - what makes this test bite is
    // that the entry has to *reverse a move that happened*. Ctrl+Z used to
    // appear to do nothing, for the same reason the nudge did.
    expect(x(a)).toBe(1);
    expect(state().history.past).toHaveLength(1);

    state().undo();
    expect(x(a)).toBe(0);
    expect(x(b)).toBe(20);
    expect(state().history.past).toHaveLength(0);
  });

  it('keeps a held slide to one undo entry', () => {
    const { a } = selectedGroup();
    installKeyboard();

    // Auto-repeat: many keydowns, one keyup.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyUp(document, { key: 'ArrowRight' });

    expect(x(a)).toBe(3);
    expect(state().history.past).toHaveLength(1);
  });

  it('writes nothing when every member is locked', () => {
    const a = createRectangle(rect(0, 0));
    const b = createRectangle(rect(20, 0));
    state().addElements([
      { ...a, locked: true },
      { ...b, locked: true },
    ]);
    const groupId = state().group([a.id, b.id]);
    if (groupId === null) throw new Error('grouping failed');
    state().select([groupId]);
    forgetHistory();
    installKeyboard();

    // The group's own flag is unlocked - grouping does not consult locks - so
    // only the inherited lock stands between this press and a move.
    const notConsumed = fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyUp(document, { key: 'ArrowRight' });

    expect(x(a.id)).toBe(0);
    expect(state().history.past).toHaveLength(0);
    // Nothing to nudge means the key was never ours, so the page keeps its
    // default scroll rather than having it swallowed for no effect.
    expect(notConsumed).toBe(true);
  });

  it('moves only the unlocked members of a partly locked group', () => {
    const a = createRectangle(rect(0, 0));
    const b = createRectangle(rect(20, 0));
    state().addElements([{ ...a, locked: true }, b]);
    const groupId = state().group([a.id, b.id]);
    if (groupId === null) throw new Error('grouping failed');
    state().select([groupId]);
    forgetHistory();
    installKeyboard();

    nudge('ArrowRight');
    expect(x(a.id)).toBe(0);
    expect(x(b.id)).toBe(21);
  });
});
