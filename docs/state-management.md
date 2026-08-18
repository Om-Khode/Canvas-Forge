# State management

One Zustand store, six slices, and the one trick that keeps a 60fps drag out of
React's render path.

Source of truth: `src/store/`, `src/components/canvas/useRenderer.ts`,
`src/components/canvas/CanvasStage.tsx`. The choice of Zustand over Redux and
Context is argued in `docs/decisions/002-state-management.md`; this document is
about the shape that resulted.

---

## 1. The slices

```ts
export type CanvasStore = ElementsSlice &
  SelectionSlice &
  ViewportSlice &
  ToolSlice &
  UiSlice &
  HistorySlice;
```

| Slice       | Holds                                                                    | In history?                    | Serialized?                       |
| ----------- | ------------------------------------------------------------------------ | ------------------------------ | --------------------------------- |
| `elements`  | `ElementStore { byId, order }`                                           | **yes** - it _is_ the document | yes                               |
| `selection` | `ReadonlySet<ElementId>`                                                 | no                             | no                                |
| `viewport`  | `{ panX, panY, zoom }` + `viewportSize`                                  | no                             | `viewport` yes, `viewportSize` no |
| `tool`      | active tool, `InteractionState`, per-tool default styles                 | no                             | no                                |
| `ui`        | panel visibility, active dialog, save status, project name, `lockAspect` | no                             | `projectName` yes                 |
| `history`   | `past` / `future` stacks, transaction depth, pending snapshot            | -                              | no                                |

The six share **one flat state object** rather than nesting under keys. That is
what lets `elementsSlice` reach `get().applyDocument(...)` on the history slice,
which is what keeps the single write path into history honest. The price is that
slice names must not collide, so they are reviewed as one surface.

### Why selection is not a flag on the element

The naive model is `selected: boolean` on `BaseElement`. It fails on four counts,
and each one is a real bug rather than a stylistic objection:

1. **It would enter history.** Selection changes go through the document, so
   `applyDocument` records them, so **Ctrl+Z undoes a click**. Working around
   that means teaching history to ignore certain fields, which is a special case
   in the one place the codebase most wants no special cases.
2. **It would dirty autosave.** `useProjectSession` schedules a save whenever
   `state.elements` changes identity. Clicking around would write to IndexedDB.
3. **It would be serialized.** Reopening a project would restore whatever was
   selected when it was last saved, which is meaningless - and the field would
   have to be validated, defaulted, and migrated forever.
4. **The maths would be worse.** Select-all becomes a pass over every element
   producing n new objects (destroying structural sharing); shift-click toggling
   becomes a find-then-patch. As a `Set<ElementId>` they are one-line set
   operations.

Selection is view state _about_ the document, not part of it. Keeping that
distinction is what makes points 1–3 not arise at all.

Two rules live in `selectionSlice.ts` as a consequence:

```ts
/** You cannot select what you cannot see. Locked elements ARE selectable -
 *  the layers panel needs a way to select one in order to unlock it. */
function selectable(state: CanvasStore, id: ElementId): boolean {
  return state.elements.byId[id]?.visible === true;
}
```

Hidden elements are excluded because handles floating over nothing, followed by a
drag that moves something invisible, is worse than a click that does nothing.
Locked elements are _not_ excluded, because the lock is about pointer
interaction, not about reachability - `engine/hitTest.isPickable` excludes them
from canvas picking, and the layers panel can still select one.

And every mutation goes through a membership comparison first:

```ts
const commit = (next: ReadonlySet<ElementId>): void => {
  const current = get().selection;
  if (sameMembers(current, next)) return;
  set({ selection: next });
};
```

Without that, `select(['a'])` on an already-selected `a` would emit a new `Set`,
which is a new reference, which re-renders every panel subscribed to the
selection and marks the renderer dirty. Clicking an already-selected element
happens constantly at the start of a drag.

### Why the viewport is in the store but not in history

It has to be in the store: the renderer reads it every frame, the toolbar
displays the zoom percentage, the export dialog's dimension estimate depends on
content bounds, and it is serialized with the project so reopening restores your
position.

It must not be in history: nobody expects Ctrl+Z to undo a scroll. This is
enforced structurally rather than by convention - `HistorySlice.applyDocument`
takes an `ElementStore` and nothing else, so there is no code path by which a
viewport change could reach a snapshot. `store.test.ts` asserts it anyway
("viewport … is not recorded in history"), because it is the kind of property
that a well-meaning refactor could quietly break.

The autosave subscription makes the same distinction, from the other side:

```ts
// features/project/useProjectSession.ts
// The viewport is deliberately not a trigger. It is saved with the next
// document write, but panning is not an edit and treating it as one would
// re-arm the debounce on every wheel event.
if (next.elements !== previous.elements || next.projectName !== previous.projectName) {
  autosave.schedule();
}
```

So the viewport is _persisted_ but not _dirtying_: it rides along with the next
document write. Pan around and close the tab without editing anything, and the
position is not saved. That is a deliberate trade, and it is the right one - the
alternative writes to IndexedDB on every wheel notch.

`viewportSize` sits in the same slice but is a different kind of thing: it is the
canvas's CSS size, owned and written by `useCanvasSize`. It lives here because
zoom-to-fit, centre-anchored zoom, and culling all need it and the alternative is
threading it through every call site. It is never serialized.

### Why `tool` holds the interaction state but not the drag data

```ts
export interface ToolSlice {
  readonly tool: ToolId;
  readonly interaction: InteractionState;
  readonly defaultStyles: Readonly<Record<StyleableToolId, ElementStyle>>;
  …
}
```

`InteractionState` is the discriminated union from `types/tools.ts` -
`idle | pending-drag | dragging | resizing | rotating | marquee | drawing |
panning | editing-text` - rather than a handful of booleans. Booleans permit
`isDragging && isResizing`; a union makes that unrepresentable, and each state
carries exactly the data that state needs.

Note what is **not** here: the in-flight drag delta, the marquee rectangle, the
draft element's id. Those change on every `pointermove`. They live in refs owned
by `usePointerInteraction` and are passed to `executeIntents` as a `GestureRefs`
bag. Putting them in the store would push React work into a path that is supposed
to touch only the renderer.

The one piece of gesture data that _is_ in the store is the marquee's origin and
current point - because it is inside the `InteractionState` union and the overlay
pass has to draw it. That is a deliberate exception, and it costs one store write
per pointermove during a marquee drag, which the canvas already handles without a
re-render (§3).

`defaultStyles` is per-tool rather than global: setting a red fill while drawing
rectangles should not repaint the next arrow's stroke.

### Why theme is not in the ui slice

```ts
/**
 * **Theme is deliberately absent.** It is owned by the `useTheme` hook and the
 * `data-theme` attribute on the document element, read synchronously from
 * localStorage at boot.
 */
```

The theme is applied by an inline script in `index.html`, before the module
bundle has parsed. Routing it through the store would mean first paint happens
before the store initialises - a visible flash of the wrong theme - in exchange
for nothing, because no other slice depends on it. `store.test.ts` asserts the
field's _absence_, which reads oddly until you realise the test is defending a
decision that a future contributor would otherwise "fix".

---

## 2. The single write path

Every document mutation funnels through one function:

```ts
// store/elementsSlice.ts
const commit = (next: ElementStore, label: string): void => {
  get().applyDocument(next, label);
};
```

`applyDocument` lives on the **history** slice. There is no code path that
changes `state.elements` without history observing it - `createElementsSlice`
does not even destructure `set` from its arguments (`(_set, get) => …`), so it
_cannot_ write state directly.

That inversion is the interesting part. The naive layering is "elements slice
owns elements, history slice observes it". Observing means either a subscription
(which fires after the fact and cannot bracket a transaction) or a middleware
(which sees every write including the viewport's). Making history the owner of
the write means the transaction boundary, the no-op guard, and the cap are all in
one place.

Two invariants hold throughout `elementsSlice`:

**Nothing is mutated.** An edit produces a new element object and a new `byId`
map in which every untouched element is the _same object reference_. That is not
a style preference - it is the entire basis of history's structural sharing
(`docs/history.md`).

**A patch that changes nothing returns the previous document object.**

```ts
function applyPatch(element: CanvasElement, patch: ElementPatch): CanvasElement {
  let changed = false;
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return element;
  return { ...element, ...patch };
}

function patchDocument(document: ElementStore, patches: ElementPatchMap): ElementStore {
  let byId: Record<ElementId, CanvasElement> | null = null;
  for (const [id, patch] of Object.entries(patches)) {
    const element = document.byId[id];
    if (element === undefined) continue;
    const next = applyPatch(element, patch);
    if (next === element) continue;
    byId ??= { ...document.byId };
    byId[id] = next;
  }
  return byId === null ? document : { byId, order: document.order };
}
```

The extra comparison pass earns its keep during a drag, which emits a patch on
every `pointermove`. Patches that land on the same value - a constrained axis, a
snapped position, a pointer that moved sub-pixel - would otherwise mint a new
object, defeat structural sharing, mark the renderer dirty, and make an aborted
drag look like a real change to history.

The reference-equality guard in `applyChange` is what turns that into behaviour a
user sees: a click that begins a transaction and moves nothing leaves no undo
entry at all.

---

## 3. The canvas is outside React

This is the load-bearing performance claim of the whole project.

### The mechanism

`CanvasStage` renders once and then stays put. It holds refs and hooks, and **no
store selector of its own**:

```tsx
export function CanvasStage({ className }: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const size = useCanvasSize(containerRef);
  useRenderer(canvasRef, size);
  const handlers = usePointerInteraction(canvasRef);
  const images = useImageDrop(canvasRef);
  …
}
```

The only thing that re-renders the component itself is its own size changing -
which happens when a panel opens, not on every frame of a drag.

`useRenderer` is the entire React↔engine seam, and it is deliberately one-way -
**nothing in it calls `useCanvasStore(selector)`**:

```ts
const renderer = new Renderer(canvas, (): RenderScene => {
  const state = useCanvasStore.getState(); // imperative read
  return {
    elements: orderCache(state.elements),
    viewport: state.viewport,
    selectedIds: state.selection,
    interaction: state.interaction,
    resolveImage,
  };
});

const unsubscribeStore = useCanvasStore.subscribe((state, previous) => {
  if (!affectsPaint(state, previous)) return;
  renderer.markDirty();
});
```

The update path is:

```
store.setState → subscribe callback → markDirty() → rAF → getScene() → paint
```

No step touches the reconciler. `useCanvasStore` is not only a hook - Zustand
stores are also imperative handles with `getState` and `subscribe`, and that is
what this relies on.

### Three details that make it hold

**`getScene` is a pull, not a push.** The renderer asks for the scene at the top
of each frame rather than being handed one on every write. Ten store writes
between two frames produce one read and one paint. It is also what lets PNG
export point a second `Renderer` at an offscreen canvas with a different scene
getter - same code path, no store involvement (`docs/export.md`).

**The subscription filters.** The store also carries dialog state, save status,
and the project name, none of which the renderer draws:

```ts
function affectsPaint(state: CanvasStore, previous: CanvasStore): boolean {
  return (
    state.elements !== previous.elements ||
    state.viewport !== previous.viewport ||
    state.selection !== previous.selection ||
    state.interaction !== previous.interaction
  );
}
```

Four pointer comparisons, and it saves a wasted frame on every UI change.

**Paint order is memoized on document identity.**

```ts
function createOrderCache(): (document: ElementStore) => readonly CanvasElement[] {
  let lastDocument: ElementStore | null = null;
  let lastResult: readonly CanvasElement[] = [];
  return (document) => {
    if (document !== lastDocument) {
      lastDocument = document;
      lastResult = elementsInOrder(document);
    }
    return lastResult;
  };
}
```

Because the elements slice returns the _same_ `ElementStore` when a change was a
no-op, panning and zooming reuse the array instead of rebuilding it once per
frame. During a drag the document genuinely changes every frame and the cache
misses every frame, which is correct: there is nothing to reuse.

There is one repaint trigger that does not come from a store write - an image
decode landing. The element never changed, only the pixels behind its key, so
`imageStore.subscribe` gets its own subscription.

### The test that proves it

`src/components/canvas/CanvasStage.test.tsx` exists for exactly one purpose. It
wraps the stage in a React `Profiler` and counts commits:

```tsx
it('does not re-render when the document changes', () => {
  const commits: string[] = [];
  const onRender: ProfilerOnRenderCallback = (_id, phase) => {
    commits.push(phase);
  };

  render(
    <Profiler id="stage" onRender={onRender}>
      <CanvasStage />
    </Profiler>
  );
  expect(commits).toEqual(['mount']);
  frames.flush();

  act(() => {
    useCanvasStore.getState().addElement(rectangle('a'));
    useCanvasStore.getState().updateElement('a', { x: 50 });
    useCanvasStore.getState().select(['a']);
  });

  // Three store writes, zero React work.
  expect(commits).toEqual(['mount']);
});
```

Three companion tests cover the rest of the contract: a burst of three writes
schedules exactly one rAF (coalescing), store changes the renderer does not draw
schedule none (the `affectsPaint` filter), and the canvas is keyboard- and
AT-reachable.

This test is here because the property is **one careless line away from silently
disappearing**. Someone adds `const zoom = useZoom()` inside `CanvasStage` to
show a debug readout, everything still works, and every `pointermove` of every
drag now runs the reconciler. Nothing else in the suite would notice. The
assertion `expect(commits).toEqual(['mount'])` is the only thing standing between
that edit and a silent 10× regression in drag cost.

To run a real frame under jsdom the test stubs `getContext('2d')` with a
permissive `Proxy` and takes control of `requestAnimationFrame` so that "a
repaint was requested" is observable. It asserts nothing about pixels - that is
explicitly out of scope (`docs/testing.md`).

### The precise claim, and its one exception

The claim is not "no React component ever renders during a drag" - that would be
false, and stating it would collapse under the first follow-up question. It is
that **the canvas host and everything expensive under it do zero React work**.

There is exactly one component inside `CanvasStage` that does re-render per
pointermove, and it is worth knowing about because it is the shape of the
exception:

```tsx
export function TextEditorOverlay() {
  const interaction = useInteraction();
  if (interaction.kind !== 'editing-text') return null;
  return <TextEditorBox elementId={interaction.elementId} />;
}
```

A canvas cannot host a caret, so text editing needs a real `<textarea>`
positioned over the element. The overlay subscribes to `state.interaction`, and
`usePointerInteraction` mirrors the machine's state into the store on every move
of a gesture (the renderer's overlay pass draws the marquee from
`scene.interaction`). So during a drag this component renders once per
pointermove - and returns `null` on its second line, having mounted nothing.

The split into two components is what keeps that acceptable: the outer half
watches one field and produces no output while idle; the inner half, which
subscribes to the viewport and the document and re-renders on every pan and every
keystroke, **only exists while a caret does**. That is the general pattern - put
the cheap guard where the frequent signal arrives, and let the expensive subtree
be conditional on it.

React is otherwise still doing the work it is good at. When the properties panel
shows `X: 120`, that number is React-rendered and changes on every frame of a
drag - which is correct and cheap, because it is one small subtree, not the
canvas.

---

## 4. Selector discipline

Nothing in Zustand prevents this:

```ts
const elements = useCanvasStore((s) => s.elements); // in a panel
```

which re-renders that panel on every frame of a drag. The codebase treats it as a
bug rather than a performance nit, and mitigates it structurally rather than by
asking people to remember.

**Twenty pre-narrowed hooks are exported**, so the correct thing is also the
shortest thing to type:

```ts
useElementStore()          useSelection()          useViewport()
useElementOrder()          useSelectionCount()     useZoom()
useElement(id)             useIsSelected(id)       useActiveTool()
useElementCount()          useSelectedIds()        useInteraction()
usePanelVisible(panel)     useSelectedElements()   useActiveStyle()
useActiveDialog()          useSaveStatus()         useDefaultStyle(tool)
useProjectName()           useHistoryStatus()
```

`useSelectionCount()` is `s.selection.size`, a number, so a panel that only
displays "3 selected" re-renders when the count changes and not when the
membership does.

**Selectors that build a new value need shallow comparison.**

```ts
export function useCanvasStoreShallow<U>(selector: (state: CanvasStore) => U): U {
  return useCanvasStore(useShallow(selector));
}
```

`useSelectedIds` returns `[...state.selection]` - a fresh array every call.
Without `useShallow`, Zustand's default `Object.is` comparison sees a new
reference on **every store write anywhere in the app** and re-renders. That is
the single easiest way to undo everything above, and it is invisible: the
component works, it is just re-rendering sixty times a second.

`useSelectedElements` and `useHistoryStatus` are the other two, both wrapped.

**Non-React consumers read `getState()` directly.** The renderer, the autosave
scheduler, the command table, and the project session are all outside React and
read the store imperatively. That the store works outside React is load-bearing,
not incidental.

**Store actions are read at call time, not subscribed to.** `ArrangeSection`
calls `useCanvasStore.getState().bringToFront(ids)` inside a click handler rather
than selecting six action functions. The actions are created once and never
replaced, so subscribing to them would add six selector runs per store write to
learn nothing.

**Deriving beats storing.** `canUndo`, `canRedo`, `undoLabel`, and `redoLabel`
are selector functions over the stacks rather than fields in state. A `canUndo`
boolean in state is a second source of truth that can disagree with the stacks it
is supposed to describe.

### Where the discipline is enforced by reference stability

Several places return the _previous_ object when nothing changed, specifically so
that subscribers do not wake up:

| Location                                                    | Guard                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `elementsSlice.applyPatch`                                  | returns the same element when no field differs                           |
| `elementsSlice.patchDocument`                               | returns the same `ElementStore` when no element changed                  |
| `elementsSlice.withOrder`                                   | returns the same store when the order array is identical                 |
| `selectionSlice.commit`                                     | returns early when membership is unchanged                               |
| `historySlice.pruneSelection`                               | returns the same `Set` when nothing was stale                            |
| `historySlice.run`                                          | keeps the previous `history` object when all four stack fields are `===` |
| `uiSlice.setSaveStatus` / `setPanelVisible` / `closeDialog` | early return on no change                                                |
| `viewportSlice.setViewportSize`                             | early return on identical dimensions                                     |

`historySlice.run`'s guard is the least obvious and the most necessary: a panel
subscribed to `history` must not re-render because some unrelated action ran a
reducer that turned out to be a no-op.

---

## 5. Cross-slice coupling, and where it is allowed

The slices are not independent, and pretending otherwise would produce worse
code. Three couplings exist on purpose:

**`elementsSlice → historySlice`.** Every document write calls
`get().applyDocument(...)`. This is the single write path and the reason the
store is one flat object.

**`historySlice → selection`.** Undo can resurrect elements and redo can delete
them again, so the selection may point at ids that are no longer in the document:

```ts
function pruneSelection(selection, document): ReadonlySet<ElementId> {
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
```

Pruning here rather than in each caller means there is one place that can get it
wrong. Note it returns the _same_ `Set` when nothing was dropped, so subscribers
that only watch the selection do not re-render on every undo.

**`toolSlice.setTool → interaction`.** Switching tools mid-gesture resets
`interaction` to idle, because the old state machine's move/up handlers would
otherwise be waiting for an event that now means something else.

Everything else is one-directional. The store imports from `types`, `utils`,
`constants`, and `features/history` - and from no component and no engine module.

---

## 6. Limitations

**Selector discipline is a convention, not a constraint.** Nothing enforces it at
compile time. An ESLint rule banning `useCanvasStore(s => s.elements)` outside the
store module would help; it is not written. The mitigation today is the twenty
narrow hooks plus one test that catches the case that matters most.

**One flat namespace.** Slice names must not collide, and there is no compiler
help - two slices both exporting `reset` would silently have one win. Reviewed as
one surface for that reason.

**No devtools time travel.** Zustand has a devtools middleware; it is not wired
up. The project's own history system is the thing that actually matters here and
is purpose-built (`docs/history.md`).

**The imperative subscription bypasses React's lifecycle.** The subscription and
the renderer both have to be torn down explicitly on unmount, and a stale
`getScene` closure would silently render old data. Contained to `useRenderer`
precisely so there is one place to get it right - but "contained" is not "safe",
and this is the file to look at first if the canvas ever renders stale content.

**The store is a singleton.** `useCanvasStore` is a module-level `create(...)`,
so two editors cannot coexist on one page and tests must call
`resetCanvasStore()` between cases. Multi-document editing would need the store
constructed per document and passed through context, which is a real refactor.

**Wrong seam for multiplayer.** CRDT or OT integration wants operations, not
snapshots, and would push work down into a document model _beneath_ the store.
Listed in the README as future work rather than designed for speculatively.
