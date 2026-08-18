/**
 * Zustand wiring for undo/redo. All of the semantics live in
 * `features/history/transaction.ts`; this file only projects the store into the
 * shape that module expects and splats the result back.
 *
 * The projection is the interesting part. `HistoryState<T>` includes `present`,
 * but the document already lives in the elements slice - so rather than store
 * it twice and maintain a sync invariant by hand, `run()` assembles the full
 * state from `{ ...state.history, present: state.elements }` (one pointer, free)
 * and destructures `present` back out on the way in.
 */

import { HISTORY_LIMIT } from '@/constants';
import {
  abortTransaction as abortCore,
  applyChange,
  beginTransaction as beginCore,
  canRedo,
  canUndo,
  commitTransaction as commitCore,
  createHistory,
  isTransactionOpen,
  redo as redoCore,
  redoLabel,
  undo as undoCore,
  undoLabel,
} from '@/features/history/transaction';
import type { HistoryState, HistoryStacks } from '@/features/history/transaction';
import type { CanvasStore } from '@/store/index';
import { withoutNestedIds } from '@/store/selectionSlice';
import type { ElementId, ElementStore } from '@/types';
import type { StateCreator } from 'zustand';

export type DocumentHistory = HistoryStacks<ElementStore>;

export interface HistorySlice {
  readonly history: DocumentHistory;

  /** Opens a transaction. Nested calls increment a depth counter. */
  beginTransaction: (label: string) => void;
  /** Closes one level; the outermost close pushes one entry, or none if nothing changed. */
  commitTransaction: () => void;
  /** Rolls back to the opening snapshot and closes every level. Escape during a drag. */
  abortTransaction: () => void;

  /**
   * The single write path for the document. Every elements-slice action funnels
   * through here, which is what guarantees nothing can mutate the document
   * without history seeing it.
   */
  applyDocument: (next: ElementStore, label: string) => void;
  /** Swaps the document and discards both stacks. Project load. */
  resetDocument: (next: ElementStore) => void;

  undo: () => void;
  redo: () => void;
}

/**
 * Stacks only - `present` is intentionally absent. `createHistory` returns it,
 * so the initial value is spelled out here rather than derived, to keep a stale
 * duplicate of the document from being parked in the slice at startup.
 */
const INITIAL_HISTORY: DocumentHistory = { past: [], future: [], depth: 0, pending: null };

/**
 * Undo can resurrect elements, and redo can delete them again - either way the
 * selection may now point at ids that are no longer in the document. Pruning
 * here rather than in each caller means there is one place that can get it
 * wrong. Returns the same Set when nothing was dropped, so subscribers that
 * only watch the selection don't re-render on every undo.
 */
function pruneSelection(
  selection: ReadonlySet<ElementId>,
  document: ElementStore
): ReadonlySet<ElementId> {
  let stale = false;
  for (const id of selection) {
    if (!(id in document.byId)) {
      stale = true;
      break;
    }
  }
  if (!stale) return selection;
  return new Set([...selection].filter((id) => id in document.byId));
}

export const createHistorySlice: StateCreator<CanvasStore, [], [], HistorySlice> = (set) => {
  const run = (reduce: (state: HistoryState<ElementStore>) => HistoryState<ElementStore>): void => {
    set((state) => {
      const next = reduce({ ...state.history, present: state.elements });
      const { present, ...stacks } = next;

      // Reference stability matters more than it looks: a panel subscribed to
      // `history` must not re-render because some unrelated action ran a
      // reducer that turned out to be a no-op.
      const unchanged =
        stacks.past === state.history.past &&
        stacks.future === state.history.future &&
        stacks.depth === state.history.depth &&
        stacks.pending === state.history.pending;

      // Two different repairs, and the second is not implied by the first.
      // `pruneSelection` drops ids the document no longer has. `withoutNestedIds`
      // re-establishes the no-nested-ids invariant, which the *document* can
      // break on its own: reparenting `a` into an already-selected `g` creates
      // the ancestor relationship with no selection write anywhere, and so does
      // undoing and redoing any reparent. The invariant is enforced where
      // selection is written (`selectionSlice`) precisely so no later reader has
      // to be independently correct against a state nobody declared legal - it
      // has to be enforced where the *document* is written for the same reason.
      // Both return their input untouched when there is nothing to fix.
      return {
        elements: present,
        history: unchanged ? state.history : stacks,
        selection: withoutNestedIds(present, pruneSelection(state.selection, present)),
      };
    });
  };

  return {
    history: INITIAL_HISTORY,

    beginTransaction: (label) => {
      run((state) => beginCore(state, label));
    },
    commitTransaction: () => {
      run((state) => commitCore(state, HISTORY_LIMIT));
    },
    abortTransaction: () => {
      run(abortCore);
    },
    applyDocument: (next, label) => {
      run((state) => applyChange(state, next, label, HISTORY_LIMIT));
    },
    resetDocument: (next) => {
      run(() => createHistory(next));
    },
    undo: () => {
      run(undoCore);
    },
    redo: () => {
      run((state) => redoCore(state, HISTORY_LIMIT));
    },
  };
};

/* -------------------------------------------------------------- selectors -- */
/* Derived rather than stored: a `canUndo` boolean in state is a second source
   of truth that can disagree with the stacks it is supposed to describe. */

export function selectCanUndo(state: CanvasStore): boolean {
  return canUndo(state.history);
}

export function selectCanRedo(state: CanvasStore): boolean {
  return canRedo(state.history);
}

/** Label of the action Ctrl+Z would reverse - "Undo Move 3 elements". */
export function selectUndoLabel(state: CanvasStore): string | null {
  return undoLabel(state.history);
}

export function selectRedoLabel(state: CanvasStore): string | null {
  return redoLabel(state.history);
}

/** Autosave checks this so nothing is written mid-drag. */
export function selectIsTransactionOpen(state: CanvasStore): boolean {
  return isTransactionOpen(state.history);
}
