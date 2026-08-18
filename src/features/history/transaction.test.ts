import { describe, expect, it } from 'vitest';

import {
  abortTransaction,
  applyChange,
  beginTransaction,
  canRedo,
  canUndo,
  commitTransaction,
  createHistory,
  isTransactionOpen,
  redo,
  redoLabel,
  resetHistory,
  undo,
  undoLabel,
} from '@/features/history/transaction';
import type { HistoryState } from '@/features/history/transaction';

/** A stand-in document. Only its object identity matters to the reducer. */
interface Doc {
  readonly v: number;
}

const LIMIT = 5;

function doc(v: number): Doc {
  return { v };
}

function labels(state: HistoryState<Doc>): string[] {
  return state.past.map((entry) => entry.label);
}

describe('createHistory', () => {
  it('starts empty with no transaction open', () => {
    const state = createHistory(doc(0));
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(0);
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
    expect(isTransactionOpen(state)).toBe(false);
  });
});

describe('implicit transactions', () => {
  it('records a standalone change as one entry', () => {
    const state = applyChange(createHistory(doc(0)), doc(1), 'Edit', LIMIT);
    expect(labels(state)).toEqual(['Edit']);
    expect(state.present.v).toBe(1);
  });

  it('ignores a change that produced the same document object', () => {
    const start = createHistory(doc(0));
    const state = applyChange(start, start.present, 'Edit', LIMIT);
    expect(state).toBe(start);
  });
});

describe('explicit transactions', () => {
  it('collapses a drag - begin, many updates, commit - into exactly one entry', () => {
    let state = beginTransaction(createHistory(doc(0)), 'Move 3 elements');
    for (let frame = 1; frame <= 40; frame++) {
      state = applyChange(state, doc(frame), 'ignored mid-drag label', LIMIT);
    }
    state = commitTransaction(state, LIMIT);

    expect(labels(state)).toEqual(['Move 3 elements']);
    expect(state.present.v).toBe(40);
    // The snapshot recorded is the document *before* the drag started.
    expect(state.past[0]?.snapshot.v).toBe(0);
  });

  it('pushes nothing when the transaction changed nothing', () => {
    const start = createHistory(doc(0));
    const state = commitTransaction(beginTransaction(start, 'Move'), LIMIT);
    expect(state.past).toHaveLength(0);
    expect(canUndo(state)).toBe(false);
  });

  it('only the outermost commit pushes, and the outermost label wins', () => {
    let state = beginTransaction(createHistory(doc(0)), 'Align 5 elements');
    state = beginTransaction(state, 'Move element');
    state = applyChange(state, doc(1), 'inner', LIMIT);
    state = commitTransaction(state, LIMIT);

    expect(state.past).toHaveLength(0);
    expect(isTransactionOpen(state)).toBe(true);

    state = commitTransaction(state, LIMIT);
    expect(labels(state)).toEqual(['Align 5 elements']);
  });

  it('a commit with no open transaction is inert', () => {
    const start = createHistory(doc(0));
    expect(commitTransaction(start, LIMIT)).toBe(start);
  });
});

describe('abortTransaction', () => {
  it('restores the opening snapshot and pushes nothing', () => {
    const opening = doc(0);
    let state = beginTransaction(createHistory(opening), 'Move');
    state = applyChange(state, doc(1), 'x', LIMIT);
    state = applyChange(state, doc(2), 'x', LIMIT);
    state = abortTransaction(state);

    expect(state.present).toBe(opening);
    expect(state.past).toHaveLength(0);
    expect(isTransactionOpen(state)).toBe(false);
  });

  it('closes every nesting level - Escape cancels the whole interaction', () => {
    let state = beginTransaction(createHistory(doc(0)), 'Outer');
    state = beginTransaction(state, 'Inner');
    state = abortTransaction(state);
    expect(state.depth).toBe(0);
  });

  it('restores the redo stack the aborted mutations cleared', () => {
    let state = applyChange(createHistory(doc(0)), doc(1), 'Edit', LIMIT);
    state = undo(state);
    expect(canRedo(state)).toBe(true);

    state = beginTransaction(state, 'Move');
    state = applyChange(state, doc(9), 'x', LIMIT);
    expect(canRedo(state)).toBe(false);

    state = abortTransaction(state);
    expect(canRedo(state)).toBe(true);
    expect(state.present.v).toBe(0);
  });
});

describe('undo / redo', () => {
  it('round-trips through a sequence of edits', () => {
    let state = createHistory(doc(0));
    state = applyChange(state, doc(1), 'First', LIMIT);
    state = applyChange(state, doc(2), 'Second', LIMIT);

    state = undo(state);
    expect(state.present.v).toBe(1);
    state = undo(state);
    expect(state.present.v).toBe(0);
    expect(canUndo(state)).toBe(false);

    state = redo(state, LIMIT);
    expect(state.present.v).toBe(1);
    state = redo(state, LIMIT);
    expect(state.present.v).toBe(2);
    expect(canRedo(state)).toBe(false);
  });

  it('surfaces the label of the next step in either direction', () => {
    let state = applyChange(createHistory(doc(0)), doc(1), 'Move 3 elements', LIMIT);
    expect(undoLabel(state)).toBe('Move 3 elements');
    expect(redoLabel(state)).toBeNull();

    state = undo(state);
    expect(undoLabel(state)).toBeNull();
    expect(redoLabel(state)).toBe('Move 3 elements');
  });

  it('clears the redo stack on the next mutation', () => {
    let state = applyChange(createHistory(doc(0)), doc(1), 'First', LIMIT);
    state = undo(state);
    state = applyChange(state, doc(7), 'Branch', LIMIT);
    expect(canRedo(state)).toBe(false);
    expect(state.present.v).toBe(7);
  });

  it('refuses to run while a transaction is open', () => {
    let state = applyChange(createHistory(doc(0)), doc(1), 'First', LIMIT);
    state = beginTransaction(state, 'Move');
    expect(undo(state)).toBe(state);
    expect(redo(state, LIMIT)).toBe(state);
    expect(canUndo(state)).toBe(false);
  });

  it('is inert on empty stacks', () => {
    const state = createHistory(doc(0));
    expect(undo(state)).toBe(state);
    expect(redo(state, LIMIT)).toBe(state);
  });
});

describe('the cap', () => {
  it('drops the oldest entries beyond the limit', () => {
    let state = createHistory(doc(0));
    for (let i = 1; i <= LIMIT + 3; i++) {
      state = applyChange(state, doc(i), `Edit ${i}`, LIMIT);
    }

    expect(state.past).toHaveLength(LIMIT);
    expect(labels(state)).toEqual(['Edit 4', 'Edit 5', 'Edit 6', 'Edit 7', 'Edit 8']);
  });

  it('bounds the past even when redo is what is pushing', () => {
    let state = createHistory(doc(0));
    for (let i = 1; i <= LIMIT; i++) state = applyChange(state, doc(i), `Edit ${i}`, LIMIT);
    for (let i = 0; i < LIMIT; i++) state = undo(state);
    for (let i = 0; i < LIMIT; i++) state = redo(state, LIMIT);

    expect(state.past).toHaveLength(LIMIT);
    expect(state.present.v).toBe(LIMIT);
  });
});

describe('structural sharing', () => {
  it('stores snapshots by reference, never by clone', () => {
    const first = doc(0);
    const second = doc(1);
    const state = applyChange(createHistory(first), second, 'Edit', LIMIT);
    expect(state.past[0]?.snapshot).toBe(first);
    expect(state.present).toBe(second);
  });
});

describe('resetHistory', () => {
  it('discards both stacks so a loaded project cannot be undone into the old one', () => {
    const edited = applyChange(createHistory(doc(0)), doc(1), 'Edit', LIMIT);
    expect(canUndo(edited)).toBe(true);

    const state = resetHistory(doc(99));
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(0);
    expect(state.present.v).toBe(99);
  });
});
