# ADR 003 - Undo/redo: snapshots with structural sharing and explicit transactions

**Status:** accepted, implemented
**Code:** `src/features/history/transaction.ts`, `src/store/historySlice.ts`

## Problem

Undo has to cover creation, deletion, movement, resizing, rotation, style edits, text edits, and layer reordering. It has to be correct - an undo that restores _nearly_ the previous state is worse than no undo - and it has to make a continuous drag a single reversible operation rather than the two hundred it physically is.

## Options considered

**Command pattern.** Each mutation is an object with `do()` and `undo()`. Memory scales with the number of operations, not document size, and the log is inspectable and mergeable - the classical answer, and what a large editor eventually needs.

**Full snapshots, deep-cloned.** Copy the document on every change. Trivially correct, one code path. Obviously wasteful: a 5,000-element document cloned on every mouse-up.

**Patch log (immer-style, or JSON Patch).** Record forward and inverse patches per change. Memory tracks change size. Needs a patch-producing layer over every mutation.

**Snapshots with structural sharing.** Snapshot the document, but treat elements as immutable so unchanged elements are shared by reference between snapshots.

## Decision

Snapshots with structural sharing, bracketed by explicit transactions.

```ts
beginTransaction('Move elements');   // pointerdown - captures the current maps by reference, O(1)
  … updateElement() per pointermove … // live state mutates; history untouched
commitTransaction();                 // pointerup - pushes ONE entry
```

## Why

**Correctness has one code path.** The command pattern's weakness is not its concept but its surface area: every mutation type needs a correct inverse, every new element property is a new inverse to write, and forward and inverse operations drift apart in ways that are hard to test and easy to ship. The failure mode is subtle - undo restores _most_ of the previous state - and it surfaces as user-reported flakiness rather than a crash. Snapshots cannot have that bug, because there is no inverse to get wrong.

**Structural sharing removes the memory objection.** The document is `{ byId: Record<ElementId, CanvasElement>, order: ElementId[] }`, and every mutation produces a _new_ map in which every unchanged element is the same object reference. Moving one rectangle in a 5,000-element document costs one new map of 5,000 pointers (~40KB) plus one new element object - not 5,000 clones. This is a property the codebase relies on, so it is asserted in a test: after a move, an untouched element is `===` its previous object.

The normalised `{ byId, order }` shape from ADR-adjacent design pays off twice here. Reordering a layer rewrites an array of strings and leaves every element object untouched, so a reorder snapshot is close to free.

**Transactions are what make dragging one undo step**, and they are a five-line concept rather than a special case bolted on. `updateElement` called outside a transaction opens and commits an implicit one, so single edits stay atomic without callers thinking about it. Nested `begin` calls increment a depth counter and only the outermost `commit` pushes - which is how "align 5 elements", internally a loop of moves, becomes one entry. `abortTransaction()` restores the opening snapshot, and is how Escape cancels an in-flight drag.

Two details that only became obvious while implementing:

- **Commit must be a no-op when nothing changed.** A click that begins a transaction and moves nothing would otherwise push an empty undo step, and the user would press Ctrl+Z and watch nothing happen. Because the snapshot is captured by reference, "did anything change" is a reference comparison, not a deep equal.
- **Abort has to restore the redo stack too.** Mutations inside the transaction cleared it; if abort only restored the document, an abandoned drag would silently destroy the user's redo history.

The pure reducer core lives in `features/history/transaction.ts` as generic operations over `HistoryState<T>`, with the Zustand slice as thin wiring. That split is why the interesting logic is unit-testable without instantiating a store - and it means the history model could be reused for a second undoable domain without touching it.

## Trade-offs

**Memory scales with document size × history depth.** Each entry costs one pointer map. Bounded by capping the stack at `HISTORY_LIMIT` (100) and dropping the oldest. The real risk is not element count but element _size_: a freehand path with thousands of points is a large object, and if it is edited repeatedly each version is retained. Images sidestep this by storing a blob key rather than pixels (ADR 004).

**No operation merging.** A command log could coalesce "typed 20 characters" into one entry heuristically. Our boundaries are explicit instead - the caller decides where a transaction starts and stops. More predictable, less clever.

**No partial or selective undo.** "Undo just this element's change" is not expressible against whole-document snapshots. Nothing in the product needs it.

**Wrong shape for collaboration.** Multiplayer needs operations to transform against each other; snapshots have discarded exactly that information. If this app gained real-time collaboration the history layer would be rewritten, not extended - which is honest, and is why the README lists collaboration as future work rather than pretending the current design accommodates it.

## Consequences

- Every mutation goes through the store's transaction path; nothing writes `elements` directly.
- Nothing pushes history from inside a `pointermove` handler. The interaction state machine emits `beginTransaction` on entering a mutating state and `commitTransaction` on leaving it.
- The same discipline applies in the UI: a drag-to-scrub numeric field brackets its gesture with the same transaction calls, so scrubbing X is one undo entry exactly like dragging on canvas.
- Entries carry a label, so the UI can offer "Undo Move 3 elements" rather than a bare "Undo".
- Selection, viewport, and UI state are excluded from snapshots. A consequence users notice: undoing a delete restores the element without re-selecting it.
- At a scale where the pointer maps became the bottleneck, the next step is a persistent immutable map (HAMT) so snapshots share structure at the _map_ level too, or a patch log. Both were judged complexity without a measured payoff at this scale.
