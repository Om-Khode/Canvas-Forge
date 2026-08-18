/**
 * The pure core of undo/redo.
 *
 * Deliberately knows nothing about Zustand, elements, or React: it is a set of
 * value-in / value-out reducers over `HistoryState<T>`. `historySlice.ts` is a
 * thin adapter that projects the store into this shape and splats the result
 * back. Keeping the interesting logic here means the transaction semantics -
 * nesting, implicit transactions, the no-op guard, the cap - are unit-testable
 * without mounting a store.
 *
 * Model: **snapshots with structural sharing**, not command/inverse-command.
 * `T` is expected to be an immutable document value (here `ElementStore`), so a
 * snapshot is one pointer. Mutating one element produces a new map in which
 * every other element is the *same object reference*, so an entry costs a map
 * of pointers plus the objects that actually changed. See
 * docs/architecture.md#history for why this beats the command pattern.
 */

/** One undo step. `snapshot` is the document *before* the change it labels. */
export interface HistoryEntry<T> {
  readonly snapshot: T;
  readonly label: string;
}

/**
 * State captured by the outermost `beginTransaction`.
 *
 * `future` is captured alongside the snapshot so that `abortTransaction` is a
 * complete rollback: a mutation inside the transaction clears the redo stack,
 * and aborting has to put it back or Escape during a drag would silently eat
 * the user's redo history.
 */
export interface PendingTransaction<T> {
  readonly snapshot: T;
  readonly label: string;
  readonly future: readonly HistoryEntry<T>[];
}

export interface HistoryState<T> {
  /** Oldest first. The last element is the next undo target. */
  readonly past: readonly HistoryEntry<T>[];
  readonly present: T;
  /** Oldest first. The last element is the next redo target. */
  readonly future: readonly HistoryEntry<T>[];
  /** Nesting depth of open transactions. 0 means none is open. */
  readonly depth: number;
  readonly pending: PendingTransaction<T> | null;
}

/**
 * The half of `HistoryState` the store persists in its own slice. `present` is
 * excluded because the document already lives in the elements slice - storing
 * it twice would create an invariant that has to be maintained by hand, and
 * the adapter can reassemble the full state for free (it is one pointer).
 */
export type HistoryStacks<T> = Omit<HistoryState<T>, 'present'>;

export function createHistory<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [], depth: 0, pending: null };
}

/**
 * Appends, dropping the oldest entries once `limit` is exceeded.
 *
 * The cap is what bounds worst-case memory: structural sharing makes each entry
 * cheap, but a document full of freehand paths with thousands of points is
 * still real memory multiplied by history depth.
 */
function pushCapped<T>(
  list: readonly HistoryEntry<T>[],
  entry: HistoryEntry<T>,
  limit: number
): readonly HistoryEntry<T>[] {
  if (limit <= 0) return [];
  const next = [...list, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Opens a transaction. Nested calls only increment the depth - the *outermost*
 * label wins, so a composite operation ("Align 5 elements") that internally
 * calls transactional primitives still reads as one action in the UI.
 */
export function beginTransaction<T>(state: HistoryState<T>, label: string): HistoryState<T> {
  if (state.depth > 0) {
    return { ...state, depth: state.depth + 1 };
  }
  return {
    ...state,
    depth: 1,
    pending: { snapshot: state.present, label, future: state.future },
  };
}

/**
 * Closes one nesting level. Only the outermost close pushes an entry, and it
 * pushes nothing when the document is reference-identical to the opening
 * snapshot - a pointerdown/pointerup that moved nothing must not leave an empty
 * step on the undo stack.
 */
export function commitTransaction<T>(state: HistoryState<T>, limit: number): HistoryState<T> {
  if (state.depth === 0) return state;

  const depth = state.depth - 1;
  if (depth > 0) return { ...state, depth };

  const pending = state.pending;
  if (pending === null || pending.snapshot === state.present) {
    return { ...state, depth: 0, pending: null };
  }

  return {
    ...state,
    depth: 0,
    pending: null,
    past: pushCapped(state.past, { snapshot: pending.snapshot, label: pending.label }, limit),
    future: [],
  };
}

/**
 * Rolls the document back to the opening snapshot and closes *every* nesting
 * level: Escape cancels the whole interaction, not one layer of it.
 */
export function abortTransaction<T>(state: HistoryState<T>): HistoryState<T> {
  const pending = state.pending;
  if (state.depth === 0 || pending === null) return state;
  return {
    ...state,
    depth: 0,
    pending: null,
    present: pending.snapshot,
    future: pending.future,
  };
}

/**
 * Records a new document value.
 *
 * Inside a transaction this only advances `present`; the entry is pushed once,
 * at commit. Outside one it opens and commits an implicit transaction, so a
 * standalone edit (a colour change, a delete) is still exactly one undo step.
 *
 * Either way the redo stack is dropped: once the user branches off the timeline
 * the old future is unreachable.
 */
export function applyChange<T>(
  state: HistoryState<T>,
  next: T,
  label: string,
  limit: number
): HistoryState<T> {
  // Reference equality is the no-op test. Callers are expected to return the
  // previous document unchanged when a patch changes nothing, which makes this
  // guard do real work rather than being defensive noise.
  if (next === state.present) return state;

  if (state.depth > 0) {
    return { ...state, present: next, future: [] };
  }

  return {
    ...state,
    past: pushCapped(state.past, { snapshot: state.present, label }, limit),
    present: next,
    future: [],
  };
}

/**
 * Undo is refused while a transaction is open. Mid-drag the document is in an
 * intermediate state that was never committed; unwinding past it would leave
 * the interaction layer holding stale drag origins.
 */
export function undo<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.depth > 0) return state;
  const entry = state.past[state.past.length - 1];
  if (entry === undefined) return state;

  return {
    ...state,
    past: state.past.slice(0, -1),
    present: entry.snapshot,
    // The label travels with the step, not with the snapshot, so redoing
    // reports the same action name the undo did.
    future: [...state.future, { snapshot: state.present, label: entry.label }],
  };
}

export function redo<T>(state: HistoryState<T>, limit: number): HistoryState<T> {
  if (state.depth > 0) return state;
  const entry = state.future[state.future.length - 1];
  if (entry === undefined) return state;

  return {
    ...state,
    past: pushCapped(state.past, { snapshot: state.present, label: entry.label }, limit),
    present: entry.snapshot,
    future: state.future.slice(0, -1),
  };
}

/**
 * Replaces the document and discards both stacks. Used when a different project
 * is loaded - the old timeline belongs to a document that is no longer open, so
 * keeping it would let Ctrl+Z paste another project's contents into this one.
 */
export function resetHistory<T>(present: T): HistoryState<T> {
  return createHistory(present);
}

/* --------------------------------------------------------------- queries -- */

export function canUndo<T>(state: HistoryStacks<T>): boolean {
  return state.depth === 0 && state.past.length > 0;
}

export function canRedo<T>(state: HistoryStacks<T>): boolean {
  return state.depth === 0 && state.future.length > 0;
}

/** Label of the step Ctrl+Z would reverse, for "Undo Move 3 elements". */
export function undoLabel<T>(state: HistoryStacks<T>): string | null {
  return state.past[state.past.length - 1]?.label ?? null;
}

export function redoLabel<T>(state: HistoryStacks<T>): string | null {
  return state.future[state.future.length - 1]?.label ?? null;
}

export function isTransactionOpen<T>(state: HistoryStacks<T>): boolean {
  return state.depth > 0;
}
