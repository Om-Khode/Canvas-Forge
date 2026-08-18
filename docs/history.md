# Undo / redo

Snapshots, structural sharing, and explicit transactions. The _why_ of choosing
this over the command pattern is `docs/decisions/003-history.md`; this document
is how it works and where it stops working.

Source of truth: `src/features/history/transaction.ts` (the pure reducer),
`src/store/historySlice.ts` (Zustand wiring), `src/features/history/transaction.test.ts`,
`src/store/store.test.ts`.

---

## 1. The model

A history entry is one snapshot of the document plus a label:

```ts
export interface HistoryEntry<T> {
  readonly snapshot: T;
  readonly label: string;
}

export interface HistoryState<T> {
  readonly past: readonly HistoryEntry<T>[]; // oldest first; last = next undo target
  readonly present: T;
  readonly future: readonly HistoryEntry<T>[]; // oldest first; last = next redo target
  readonly depth: number; // open transaction nesting; 0 = none
  readonly pending: PendingTransaction<T> | null;
}
```

`T` is generic. The module knows nothing about Zustand, elements, or React - it
is a set of value-in/value-out reducers, and `historySlice.ts` is a thin adapter.
That split is why the transaction semantics (nesting, implicit transactions, the
no-op guard, the cap) are unit-testable without mounting a store, and why the
model could serve a second undoable domain untouched.

`snapshot` is the document **before** the change the entry labels. So undoing
"Move 3 elements" restores the state that existed before the move.

### `present` is not stored twice

The store's history slice holds `HistoryStacks<T> = Omit<HistoryState<T>, 'present'>`,
because the document already lives in the elements slice. Storing it in both
would create an invariant maintained by hand. The adapter reassembles the full
state per call - which is free, because it is one pointer:

```ts
// store/historySlice.ts
const run = (reduce: (state: HistoryState<ElementStore>) => HistoryState<ElementStore>): void => {
  set((state) => {
    const next = reduce({ ...state.history, present: state.elements });
    const { present, ...stacks } = next;
    …
    return { elements: present, history: unchanged ? state.history : stacks, … };
  });
};
```

---

## 2. Structural sharing, with real arithmetic

"Undo swaps whole document snapshots" sounds ruinous and is not, because elements
are treated as immutable everywhere. A snapshot is a _pointer_ to an
`ElementStore`, and mutating one element produces a new `byId` map in which every
other element is the same object reference (`docs/state-management.md §2`).

Take a 5,000-element document and move one rectangle.

**Deep clone (the naive snapshot).** Every element is copied. A `RectangleElement`
has 14 fields - an object header plus 14 slots is ~128 bytes, and `id`, `name`,
`fill`, `stroke`, and `strokeStyle` are strings, so call it 250–400 bytes in
practice. At 5,000 elements that is roughly **1.5 MB per entry**. With
`HISTORY_LIMIT = 100`, worst case ≈ **150 MB** of retained snapshots for a
document that is itself 1.5 MB. That is not a tuning problem, it is a
disqualification.

**Structural sharing.** The entry costs one new `byId` map plus the one element
that actually changed. The map holds 5,000 pointers: 5,000 × 8 bytes = **40 KB**
of raw references, and a keyed JavaScript object carries engine overhead on top
of that - key slots, property details, and a load factor - so the honest figure
is some small multiple, on the order of 100–250 KB. Even taking the pessimistic
end, 100 entries is roughly **10–25 MB**, and it is dominated by pointer maps
rather than by element data.

So the reduction is somewhere between 6× and 40× depending on how you count the
engine's object overhead. The exact multiple does not matter; what matters is
that the deep-clone cost scales with `document bytes × depth` and the shared cost
scales with `element count × depth` - a much smaller constant, and one that does
not grow when elements get _bigger_.

The arithmetic above is arithmetic, not measurement. Measured figures live in
`docs/performance.md`.

The codebase depends on this property, so it is asserted rather than assumed:

```ts
// store.test.ts
it('patches an element without touching the others', () => {
  …
  expect(state().elements.byId[b.id]).toBe(before[b.id]);   // untouched element is ===
  expect(state().elements.byId).not.toBe(before);           // the map is new
});
```

And the layer-reorder case, which is the cheapest of all - a new `order` array of
strings, with the _same_ `byId` object:

```ts
it('reorders layers without producing new element objects', () => {
  …
  expect(state().elements.byId).toBe(before);
});
```

### What this does not fix

Memory tracks change _count_, not change _size_. A freehand path with 4,000
sample points is one large object, and editing it repeatedly retains every
version. Images sidestep the problem by construction - an `ImageElement` holds a
content-hash string, never pixels (`docs/data-model.md §2`) - but freehand does
not, and it is the realistic worst case for this design.

---

## 3. Transactions

The reason a continuous drag is one undo step and not the two hundred it
physically is.

```ts
beginTransaction('Move elements');   // pointerdown - captures the current document by reference, O(1)
  … applyPatches() per pointermove … // live state mutates; history untouched
commitTransaction();                 // pointerup - pushes ONE entry
```

The three reducers:

```ts
export function beginTransaction<T>(state: HistoryState<T>, label: string): HistoryState<T> {
  if (state.depth > 0) return { ...state, depth: state.depth + 1 };
  return { ...state, depth: 1, pending: { snapshot: state.present, label, future: state.future } };
}

export function commitTransaction<T>(state: HistoryState<T>, limit: number): HistoryState<T> {
  if (state.depth === 0) return state;
  const depth = state.depth - 1;
  if (depth > 0) return { ...state, depth };

  const pending = state.pending;
  if (pending === null || pending.snapshot === state.present) {
    return { ...state, depth: 0, pending: null }; // ← the no-op guard
  }
  return {
    ...state,
    depth: 0,
    pending: null,
    past: pushCapped(state.past, { snapshot: pending.snapshot, label: pending.label }, limit),
    future: [],
  };
}

export function abortTransaction<T>(state: HistoryState<T>): HistoryState<T> {
  const pending = state.pending;
  if (state.depth === 0 || pending === null) return state;
  return { ...state, depth: 0, pending: null, present: pending.snapshot, future: pending.future }; // ← restores the redo stack
}
```

### Nesting: only the outermost commit pushes

`depth` is a counter, not a boolean. Nested `begin` calls increment it; only the
outermost `commit` pushes an entry, and **the outermost label wins**. That is how
a composite operation reads as one action:

```ts
// store.test.ts
it('composes nested transactions into one entry', () => {
  … beginTransaction('Align 2 elements') → two inner transactional moves → commit …
  expect(selectUndoLabel(state())).toBe('Align 2 elements');
});
```

### Implicit transactions

`applyChange` outside a transaction opens and commits one implicitly:

```ts
export function applyChange<T>(state, next: T, label: string, limit: number): HistoryState<T> {
  if (next === state.present) return state; // reference-equality no-op test
  if (state.depth > 0) return { ...state, present: next, future: [] };
  return {
    ...state,
    past: pushCapped(state.past, { snapshot: state.present, label }, limit),
    present: next,
    future: [],
  };
}
```

So a colour change, a delete, or a layer reorder is atomic without the caller
thinking about transactions at all. Callers only reach for `beginTransaction`
when a _gesture_ has to be one entry.

### Why commit is a no-op when nothing changed

A click that begins a transaction and moves nothing would otherwise push an empty
undo step. The user then presses Ctrl+Z and watches nothing happen, presses it
again, and now something unexpected is undone. It is the kind of defect that gets
reported as "undo is flaky".

Because the snapshot is captured **by reference**, "did anything change" is a
single reference comparison - `pending.snapshot === state.present` - not a deep
equality walk. That guard only does real work because of the discipline one layer
down: `patchDocument` returns the previous `ElementStore` object when a patch
changes nothing (`docs/state-management.md §2`). Without that, a drag that ended
where it started would produce a _new_ `ElementStore` with identical contents, the
reference test would fail, and an empty entry would be pushed.

The two guards are a pair. Either one alone is insufficient.

```ts
it('records nothing for a click that moved nothing', () => { … });
```

### Why abort has to restore the redo stack

`PendingTransaction` carries three things, and the third is the one that is easy
to forget:

```ts
export interface PendingTransaction<T> {
  readonly snapshot: T;
  readonly label: string;
  readonly future: readonly HistoryEntry<T>[];
}
```

Mutations inside a transaction clear the redo stack - `applyChange` sets
`future: []` whether or not a transaction is open, because the user has branched
off the timeline. If abort only restored the document, an abandoned drag would
silently destroy the redo history that the user never actually branched away
from. Capturing `future` at `begin` and restoring it at `abort` makes the whole
gesture invisible to history, which is what "cancel" means.

Abort also closes **every** nesting level (`depth: 0`, not `depth - 1`): Escape
cancels the whole interaction, not one layer of it.

### Undo and redo are refused mid-transaction

```ts
export function undo<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.depth > 0) return state;
  …
}
```

Mid-drag the document is in an intermediate state that was never committed.
Unwinding past it would leave the interaction layer holding drag origins that no
longer correspond to anything. `canUndo`/`canRedo` include the same check, so the
toolbar buttons and the command palette grey out rather than offering an action
that will be silently refused.

The same flag is why autosave is blocked during a transaction:
`selectIsTransactionOpen` is read by `useProjectSession`, which calls
`autosave.setBlocked(open)` - so nothing is ever written mid-drag.

### Labels travel with the step

```ts
future: [...state.future, { snapshot: state.present, label: entry.label }],
```

Undo takes the label from the entry it is reversing and attaches it to the redo
entry it creates, so redoing reports the same action name the undo did. The
toolbar can offer "Undo Move 3 elements" and then "Redo Move 3 elements", not a
bare "Redo".

Labels are generated where the operation is, and pluralized:

```ts
function countLabel(count: number): string {
  return count === 1 ? '1 element' : `${count} elements`;
}
```

### The cap

```ts
function pushCapped<T>(list, entry, limit): readonly HistoryEntry<T>[] {
  if (limit <= 0) return [];
  const next = [...list, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
```

`HISTORY_LIMIT = 100`. Oldest entries are dropped. Structural sharing makes each
entry cheap, but cheap × unbounded is still unbounded, and the freehand case
above is the reason the bound exists.

Dropping the oldest entry also releases every element object that only that
snapshot still referenced - which is how the memory is actually reclaimed rather
than merely bounded.

### Loading a project resets everything

```ts
export function resetHistory<T>(present: T): HistoryState<T> {
  return createHistory(present);
}
```

Both stacks are discarded on project load. The old timeline belongs to a document
that is no longer open; keeping it would let Ctrl+Z paste another project's
contents into this one. `elementsSlice.replaceDocument` routes to
`historySlice.resetDocument` for exactly this.

---

## 4. Where the bracketing is reused

Transactions are not a canvas-only concept. Four call sites use the same three
calls, which is the point - the concept is five lines, so it can be applied
anywhere a gesture produces many writes.

### Canvas gestures - the state machine

`features/canvas/interaction/machine.ts` emits `beginTransaction` on entering a
mutating state and `commitTransaction` on leaving it. Every mutating state does
this:

| Entering   | Label                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| `dragging` | `Move elements`                                                                           |
| `resizing` | `Resize elements`                                                                         |
| `rotating` | `Rotate elements`                                                                         |
| `drawing`  | `Draw rectangle` / `Draw ellipse` / `Draw line` / `Draw arrow` / `Draw path` / `Add text` |

Escape or a `cancel` event (pointer capture lost, window blurred, `pointercancel`)
emits `abortTransaction`. The machine is careful not to emit it from a state that
never began one.

Note that the machine is a **pure reducer** - it emits an _intent_, and
`executeIntents.ts` is the only place an intent becomes a store call. Nothing
pushes to history from inside a `pointermove` handler.

### The properties panel's drag-to-scrub

A `NumberField`'s label is also a drag handle: dragging it scrubs the value. That
emits an `onChange` per `pointermove`, exactly like a canvas drag, and gets
exactly the same treatment:

```tsx
// components/panels/PropertiesPanel.tsx
const beginScrub = useCallback((label: string): void => {
  useCanvasStore.getState().beginTransaction(label);
}, []);

const endScrub = useCallback((): void => {
  useCanvasStore.getState().commitTransaction();
}, []);
```

Passed down to every section as `onScrubStart` / `onScrubEnd`. Scrubbing X is one
undo entry, exactly like dragging on canvas. If the field were typed into instead
of scrubbed, each committed value is one implicit transaction - which is also
right, because typing "1", "10", "100" and tabbing away is one intentional edit
per commit, not per keystroke (the fields stay locally controlled while focused).

### Held-key arrow nudging

The subtlest case, and the one that could not be a command-table row.

A held arrow key auto-repeats at roughly 30 Hz. Each repeat is a real edit -
`translateElements` by `NUDGE_STEP = 1` world unit, or `10` with Shift. Applying
each as its own entry would put thirty steps on the undo stack for one continuous
slide.

```ts
// features/commands/useCommands.ts - createNudger
if (!open) {
  open = true;
  store.getState().beginTransaction('Move elements');
}
… applyPatches(translateElements(elements, delta.x * step, delta.y * step), …) …
held.add(event.key.toLowerCase());
if (timer !== null) clearTimeout(timer);
timer = setTimeout(commit, NUDGE_IDLE_COMMIT_MS);
```

Committed on `keyup` - but only when **every** arrow is released, because a
diagonal nudge holds two keys and must stay one entry:

```ts
const keyUp = (event: KeyboardEvent): void => {
  if (!open) return;
  held.delete(event.key.toLowerCase());
  if (held.size === 0) commit();
};
```

Three failure modes are handled explicitly, and each is a case where a transaction
would otherwise be left open - which blocks autosave and refuses undo until
something closes it:

- **A `keyup` that never arrives** (window loses focus, an OS shortcut swallows the
  release). `NUDGE_IDLE_COMMIT_MS = 500` is a safety-net timer, comfortably longer
  than the ~30 ms repeat interval so it can never fire mid-slide.
- **Window blur.** A `blur` listener calls `nudger.commit()`.
- **Unmount.** The teardown calls it too.

Nudging refuses to start while a dialog is open or while `interaction.kind !== 'idle'`,
so it can never nest into a pointer gesture the user is still performing.

The no-op guard does the rest: a press that moved nothing (everything locked,
say) leaves no entry.

### Align and distribute - no bracketing needed

`ArrangeSection` moves five elements with **no** explicit transaction:

```tsx
useCanvasStore.getState().applyPatches(alignElements(elements, edge), label);
```

One store call, one implicit transaction, one entry. That works because
`alignElements` is a pure `(elements, edge) => patches` function rather than
something that mutates as it goes. Purity in the maths layer is what removes the
need for bracketing in the UI layer.

---

## 5. Limits, stated plainly

**Memory scales with document size × history depth.** Bounded at
`HISTORY_LIMIT = 100`. Beyond that, the oldest work is unrecoverable. The real
risk is element _size_, not element count: repeated edits to a large freehand path
retain every version.

**Undo does not restore selection.** Selection, viewport, and UI state are
excluded from snapshots (`docs/state-management.md §1`). A user-visible
consequence: undoing a delete brings the element back **without re-selecting it**.
Restoring selection would mean putting it in the snapshot, which would mean
selection changes are candidates for entering history - the exact coupling the
slice separation exists to prevent. The trade was taken knowingly.

**No operation merging.** A command log could heuristically coalesce "typed 20
characters" into one entry. Here the boundaries are explicit: the caller decides
where a transaction starts and stops. More predictable, less clever, and it means
a caller that forgets to bracket gets one entry per write rather than something
subtly half-merged.

**No partial or selective undo.** "Undo just this element's change" is not
expressible against whole-document snapshots. Nothing in the product needs it.

**Undo is refused, not queued, mid-transaction.** Pressing Ctrl+Z during a drag
does nothing rather than being applied afterwards. The buttons and the palette
reflect that, so it is visible rather than mysterious.

**Wrong shape for collaboration.** Multiplayer needs operations that can be
transformed against each other; snapshots have discarded exactly that
information. Real-time collaboration would mean rewriting this layer, not
extending it - which is why the README lists it as future work rather than
pretending the current design accommodates it.

**Where it would go next.** At a scale where the pointer maps became the
bottleneck, the options are a persistent immutable map (HAMT) so that snapshots
share structure at the _map_ level too, or a patch log. Both were judged
complexity without a measured payoff at this scale. `docs/performance.md` is
where the measurement to justify either would live.
