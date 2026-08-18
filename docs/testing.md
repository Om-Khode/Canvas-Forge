# Testing

What is tested, what deliberately is not, and one bug the whole suite could never
have caught.

Runner: Vitest with the jsdom environment; React Testing Library + `jest-dom` for
components. Config in `vite.config.ts`, one global setup file at
`src/test/setup.ts`. `npm run test`.

**933 tests across 54 files** as of the element-grouping branch. It was 654 across
41 files when this document was first written, and 676 immediately before
grouping landed; the numbers below the header are from that earlier snapshot
except where §1b updates them. Treat every number as a snapshot; the _shape_ is
the point. Regenerate with `npx vitest run --reporter=json`.

---

## 1. Where the tests are, and why they are there

Coverage is weighted deliberately, not uniformly. The rule applied throughout:
**test the logic that is easy to get subtly wrong and hard to notice**, and skip
the logic whose failure is immediately obvious.

### Pure maths and model logic - 201 tests

| File                                          | Tests | What it pins                                                            |
| --------------------------------------------- | ----- | ----------------------------------------------------------------------- |
| `utils/geometry.test.ts`                      | 29    | rect normalization, intersection, union, rotated AABB, point-to-segment |
| `features/elements/operations.test.ts`        | 27    | resize in a rotated frame, rotate-about-a-pivot, translate, z-order     |
| `features/elements/factory.test.ts`           | 23    | complete elements, normalized endpoints, `Rectangle N` naming           |
| `features/canvas/engine/matrix.test.ts`       | 20    | compose, invert, singular refusal, `elementMatrix` composition          |
| `features/canvas/engine/hitTest.test.ts`      | 20    | rotated shapes, hollow bands, stroke tolerance, top-down order          |
| `features/properties/mixed.test.ts`           | 18    | uniform / mixed / absent, and `applicablePatches`                       |
| `features/selection/handles.test.ts`          | 16    | handle positions under rotation, screen-fixed hit padding               |
| `features/alignment/align.test.ts`            | 14    | align edges, distribute gaps                                            |
| `features/canvas/engine/drawers/text.test.ts` | 12    | greedy wrap, hard newlines, over-wide word breaking                     |
| `features/selection/bounds.test.ts`           | 11    | single vs multiple, rotation-aware union                                |
| `utils/coords.test.ts`                        | 11    | round trips, delta-without-pan, zoom-about-cursor invariants            |

This is the largest block and it is the right one to be largest. Every file here
is a pure function of its inputs, so the tests are cheap, fast, and precise, and
they cover exactly the arithmetic whose failure mode is "slightly wrong, in a way
you only notice at 40% zoom on a rotated element".

Two of these are worth singling out.

`coords.test.ts` is only 11 tests and is probably the highest-value file in the
suite. It pins the zoom-about-cursor invariant _including under clamping_:

```ts
it('holds the anchor fixed even when the requested zoom is clamped', () => {
  const next = zoomAroundPoint(viewport, cursor, MAX_ZOOM * 100);
  expect(next.zoom).toBe(MAX_ZOOM);
  // …and the anchor still maps to the same world point
});
```

and the delta-without-pan rule, which is the bug that works perfectly at 100%
zoom and drifts everywhere else (`docs/coordinate-system.md §2`).

`hitTest.test.ts` covers the case that motivates the whole matrix-inversion
design: a point inside a rotated rectangle, which is a hit that a naive
axis-aligned test reports as a miss.

### Interaction and commands - 122 tests

| File                                          | Tests |
| --------------------------------------------- | ----- |
| `features/canvas/interaction/machine.test.ts` | 54    |
| `features/commands/clipboard.test.ts`         | 19    |
| `features/commands/createCommands.test.ts`    | 14    |
| `features/shortcuts/chord.test.ts`            | 14    |
| `features/shortcuts/registry.test.ts`         | 12    |
| `features/canvas/interaction/cursor.test.ts`  | 9     |

`machine.test.ts` is the single largest file, and that is a direct consequence of
the interaction layer being split into a pure reducer plus an impure adapter. The
machine is `(state, event, context) => { state, intents }` - it reads nothing and
writes nothing - so every transition in `docs/architecture.md §10` can be driven
from a literal object with no canvas, no jsdom, and no store. That is the
difference between "the drag threshold is probably 3px" and a test that says so.

The split was made _for_ testability and it paid for itself: 54 tests over a
nine-state machine with modifier keys, a drag threshold, click-to-place, and
abort semantics would be nearly impossible to write against real pointer events.

`chord.test.ts` is where `docs/problems-log.md` entry 001 lives - a unit test
caught `Ctrl+Shift+Z` collapsing onto `Ctrl+Z` before it ever ran in a browser.

### State and history - 51 tests

`features/history/transaction.test.ts` (19) tests the pure reducer: nesting,
implicit transactions, the no-op guard, abort restoring the redo stack, the cap.

`store/store.test.ts` (32 in this snapshot; **70** now - see §1b) is explicitly an **integration** suite over the
composed store, and its header says so:

```ts
/**
 * These exercise the wiring the unit tests can't see: that elements-slice
 * actions really do funnel through history, that selection really is invisible
 * to it, and that structural sharing survives the trip through Zustand.
 */
```

Several of its assertions are about _object identity_ rather than values, because
identity is the mechanism:

```ts
expect(state().elements.byId[b.id]).toBe(before[b.id]); // structural sharing
expect(state().elements).toBe(before); // a no-op patch is a no-op
expect(state().elements.byId).toBe(before); // a reorder mints no elements
expect(state().selection).toBe(selection); // membership-equal Set is reused
```

Those are the four properties everything else in `docs/history.md` and
`docs/state-management.md` rests on. Asserting values would pass while the
performance characteristics silently disappeared.

### Persistence and serialization - 67 tests

| File                                  | Tests |
| ------------------------------------- | ----- |
| `features/project/validate.test.ts`   | 17    |
| `services/imageStore.test.ts`         | 12    |
| `services/autosave.test.ts`           | 11    |
| `services/projectRepository.test.ts`  | 11    |
| `features/project/migrations.test.ts` | 9     |
| `features/project/serialize.test.ts`  | 7     |

`migrations.test.ts` tested a mechanism that had never run in production: when
this was written the chain was empty, because there had only ever been one schema
version. It was tested against a **synthetic v0→v1→v2 chain**, which is why
`migrateDocument` takes the chain and target version as parameters rather than
reading module constants. The mechanism was proven before it was needed, rather
than written under pressure at the first breaking change with real user files at
stake - and grouping's v1→v2 step is that first real use, landing into machinery
that already had its own tests.

`autosave.test.ts` runs entirely on fake timers, which is possible because the
scheduler holds no React state and imports no store - it is a plain object with
four methods and an injected `save`. Debounce, blocking during a transaction,
coalescing an in-flight save, and _not_ re-arming after an error are all
observable that way.

### Export - 43 tests

`svg.test.ts` (19), `png.test.ts` (18), `json.test.ts` (6). See §2 for how PNG is
testable at all under jsdom.

### Images and performance harness - 47 tests

| File                                   | Tests |
| -------------------------------------- | ----- |
| `features/images/ingest.test.ts`       | 18    |
| `features/perf/stressDocument.test.ts` | 16    |
| `features/perf/benchmark.test.ts`      | 13    |

These landed after the rest of this document was written and are owned elsewhere -
the performance harness and its findings are documented in
`docs/performance.md`. `ingest.test.ts` uses the same `createMemoryBackend` and
injected-codec pattern described in §2.

### Components - 120 tests

| File                                           | Tests |
| ---------------------------------------------- | ----- |
| `components/panels/LayersPanel.test.tsx`       | 22 (**50** now - see §1b) |
| `components/panels/PropertiesPanel.test.tsx`   | 20    |
| `components/canvas/TextEditorOverlay.test.tsx` | 17    |
| `components/common/NumberField.test.tsx`       | 16    |
| `components/common/Tooltip.test.tsx`           | 10    |
| `components/panels/Minimap.test.tsx`           | 10    |
| `components/common/Dialog.test.tsx`            | 8     |
| `components/dialogs/CommandPalette.test.tsx`   | 8     |
| `components/common/Toggle.test.tsx`            | 5     |
| `components/canvas/CanvasStage.test.tsx`       | 4     |

Chosen by risk, not by component count. The two panels are the components with
real logic (multi-selection, mixed values, reordering, drag-and-drop). The four
common primitives are the ones with accessibility contracts that are easy to
break silently - focus trapping, `aria-pressed`, roving tabindex, `role="alert"`.
A `Button` has no test because a broken button is not a subtle failure.

`CanvasStage.test.tsx` has only 4 tests and is discussed at length in
`docs/state-management.md §3`. It exists to defend one property - a document
change must not re-render the canvas component - using a React `Profiler` to count
commits. It is the cheapest test in the suite and guards the most expensive
regression.

## 1b. Element grouping - twelve new files, and one thing they could not catch

Grouping took the suite from 676 to **933 tests across 54 files**. Twelve files
are new, and they are split by what each layer can actually prove.

**Pure, over `ElementStore` literals with no store and no DOM:**

| File                                       | Tests | What it pins                                                                 |
| ------------------------------------------ | ----- | ---------------------------------------------------------------------------- |
| `features/elements/tree.test.ts`           | 32    | every walk; cycle termination; effective lock/visibility; derived bounds     |
| `features/selection/resolve.test.ts`       | 18    | click resolves to the outermost ancestor; entered-group descent; leaf sets   |
| `components/panels/dropTarget.test.ts`     | 17    | three-zone resolution, and every drop the panel must refuse                  |
| `features/elements/group.test.ts`          | 14    | group/ungroup z-order placement, sibling-only membership, `canGroup` parity  |
| `components/panels/layerRows.test.ts`      | 12    | tree → flat rows, collapsed subtrees absent, `aria-posinset` sequencing      |
| `features/elements/reparent.test.ts`       | 10    | the pull-it-out-first index correction; cycle refusal; same-store no-ops     |
| `features/export/scope.test.ts`            | 9     | which of the three arrays each exporter gets, and why they differ            |
| `store/patchDocument.test.ts`              | 6     | the write path the derive pass hangs off                                     |

`features/canvas/interaction/executeIntents.test.ts` (19) came with selection
resolution: the intent executor is the only place an intent becomes a store
write, and grouping made *which elements a gesture writes to* a real question.
Three more exist only because of the root-only-selector sweep, each pinning one
call site against the **real** selector rather than a fixture -
`components/dialogs/ExportDialog.test.tsx` (4),
`components/toolbar/ZoomControls.test.tsx` (3),
`features/project/useProjectSession.test.ts` (1). See "The gap this suite had"
below for why they had to be written that way.

**Store-level**, in `store.test.ts` (now 70 tests), because these are properties
of the wiring rather than of any one module: group and ungroup are each exactly
one undo entry; deleting a group removes its descendants; structural sharing
survives the derive pass; and the load-bearing one -

```ts
// The design's central claim, checked rather than asserted in prose:
// transforming a group IS transforming its leaves.
expect(translateElements(gestureTargets(store, [groupId]), 7, 11))
  .toEqual(/* the patch map from translating [a, b] directly */);
```

**Panel-level**, in `LayersPanel.test.tsx` (now 50 tests): treegrid roles,
`aria-level` / `aria-expanded`, expand and collapse by keyboard, and
selection-follow expanding collapsed ancestors before it scrolls.

### `aria-rowcount` changed meaning, deliberately

It counted total elements; it now counts **visible rows**. That is the correct
meaning rather than a compromise - `buildLayerRows` omits a collapsed group's
members from the row array entirely rather than hiding them, so they are not
reachable by arrow key, and counting them would misreport the list's length to a
screen reader. The existing virtualization assertions asserted the old meaning
and were changed with the reason stated in the commit rather than quietly.

### The gap this suite had, and it is a shape rather than a number

Narrowing `ElementStore.order` to root-level ids changed no type and broke twelve
production call sites. **None of the ~900 tests failed.** The reason is
structural: these tests build `ElementStore` literals directly and assert on the
module under test, so almost none of them route through the selector whose
*contract* changed while its *inputs* did not. Every one of the twelve was found
by code review; three were found from three unrelated directions in three
separate reviews. `docs/problems-log.md` entry 006 is the write-up.

The remedy applied was to demand **a test per call site that reaches through the
real selector**, which is the only shape of test that could have failed. It is
the same lesson §4 draws from entry 002, arriving from a different direction:
fixtures test the module; only the real wiring tests the wiring.

---

## 2. The injectable-seam pattern

**jsdom has no 2D canvas context, no `createImageBitmap`, and no IndexedDB.**
Roughly half of this application talks to one of those three. The naive
consequences are either "don't test that half" or "add heavy fakes"
(`fake-indexeddb`, `jest-canvas-mock`, `node-canvas`), each of which is a
dependency whose fidelity to the real API you then have to trust.

The pattern used instead: **put the browser-only operation behind a small
interface, default it to the real implementation, and let the test pass a stub.**
It appears three times, and in two of the three the seam turned out to earn its
keep in production as well.

### `StorageBackend` - a seam that is also the degradation path

```ts
export interface StorageBackend {
  get(store: StoreName, key: string): Promise<Result<unknown, StorageError>>;
  getAll(store: StoreName): Promise<Result<readonly unknown[], StorageError>>;
  getAllKeys(store: StoreName): Promise<Result<readonly string[], StorageError>>;
  put(store: StoreName, key: string, value: unknown): Promise<Result<void, StorageError>>;
  delete(store: StoreName, key: string): Promise<Result<void, StorageError>>;
}

export function createIndexedDbBackend(): StorageBackend { … }
export function createMemoryBackend(): StorageBackend { … }
```

`createMemoryBackend()` is **not a test double**. It is the fallback the app swaps
to when `openDatabase()` reports `unavailable` - Safari private mode, storage
disabled by policy - so the editor still works for the session instead of failing
to boot. The repository suite then runs against it:

```ts
/**
 * The suite runs against `createMemoryBackend()` - the same object the app
 * falls back to when IndexedDB is unavailable - rather than `fake-indexeddb`.
 * That keeps the dependency list at zero and, more usefully, means the fallback
 * path is covered by the repository's own tests instead of being untested code
 * that only executes in Safari private mode.
 */
```

That is the interesting property: the code path that would otherwise be untested
and only ever run in front of a user, in a browser the developer does not use, is
now the most heavily exercised path in the suite. The seam was introduced for
testability and the production benefit fell out of it.

`imageStore.test.ts` uses the same backend for the same reason.

Reads return `unknown` rather than the hoped-for type, which is a separate but
related honesty: whatever came out of the database was written by an older build,
hand-edited, or corrupted, and typing it optimistically is a lie the compiler
would then propagate. Callers narrow it through `features/project/validate.ts`.

### `ImageCodec` - a seam that draws an honest boundary

```ts
export interface ImageCodec {
  measure(blob: Blob): Promise<{ width: number; height: number }>;
  /** Re-encode at the given size. `null` means "not possible here - store the original". */
  resize(blob: Blob, width: number, height: number): Promise<Blob | null>;
}
```

The default implementation uses `createImageBitmap` and a canvas, neither of which
exists in jsdom. The test stubs it:

```ts
/**
 * The browser codec cannot run under jsdom … so the codec is injected. That
 * draws the line honestly: these tests cover the ingest *policy* (type
 * allow-list, size cap, hashing, dedupe, downscale arithmetic) and make no
 * claim about the browser's decoder.
 */
```

That last sentence is the point of the whole pattern. The seam does not pretend
to test image decoding - it separates the part that _is_ ours (which files are
accepted, when downscaling triggers, what the key is hashed from, whether a
duplicate upload writes twice) from the part that is the platform's. The 12 tests
make a precise claim rather than a vague one.

The `resize` contract returning `null` for "not possible here" is a real
production behaviour too: GIFs and SVGs are deliberately not rasterised, and a
context that cannot be obtained falls back to storing the original.

### The PNG dependency bag - the most granular seam

```ts
export interface PngExportDeps extends Partial<ImageDecodeDeps> {
  readonly createCanvas?: (widthPx: number, heightPx: number) => HTMLCanvasElement;
  readonly paint?: (canvas: HTMLCanvasElement, scene: RenderScene, options: PaintOptions) => void;
  readonly encode?: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
  readonly resolveImage?: (key: string) => CanvasImageSource | null;
  readonly subscribeImages?: (listener: (key: string) => void) => () => void;
  readonly decodeTimeoutMs?: number;
}
```

Every parameter is optional and defaults to the real thing, so production code
calls `exportPng(request)` with no ceremony. The tests substitute trivial fakes:

```ts
const fakeCanvas = (): HTMLCanvasElement => ({}) as HTMLCanvasElement;
const fakeBlob = (): Blob => ({ size: 1, type: 'image/png' }) as Blob;
```

`{}` is a sufficient canvas because nothing in the tested path touches it - that
is what proves the arithmetic is genuinely separate from the pixels.

This buys three things that are otherwise untestable:

**The orchestration order.** That decodes complete _before_ painting starts:

```ts
await Promise.resolve();
expect(order).toEqual([]); // nothing painted yet

decoded.add('blob-key');
order.push('decoded');
bus.notify?.('blob-key');

await pending;
expect(order).toEqual(['decoded', 'paint']);
```

This is the bug from `docs/export.md §1` - an export shipping without its images -
pinned as a sequencing assertion.

**The scene's contents.** That `selectedIds` is empty and `interaction` is idle,
so no selection chrome is baked into the file. Asserted by inspecting the
argument passed to the stub `paint`.

**Every error branch.** `encode` resolving `null` produces `encode-failed` rather
than a zero-byte download. That path is unreachable in a real browser without
deliberately breaking it.

The clamp arithmetic needs no seam at all, because `planPngExport` is a pure
function - which is why it was split out. Half the value of the seam is that it
made the _pure/impure_ boundary explicit enough to notice.

### Two smaller seams

`TextMeasurer` in `engine/drawers/text.ts` narrows the 2D context down to the one
method wrapping actually uses:

```ts
export interface TextMeasurer {
  measureText(text: string): { readonly width: number };
}
```

so `wrapText` and `measureTextBlock` are testable with `{ measureText: (t) => ({ width: t.length * 10 }) }`
- and the narrowing simultaneously documents that wrapping reads font metrics and
nothing else.

`createCommands(deps)` is a factory over `{ store, clipboard, session, openExport,
importJson, toggleTheme, isDarkTheme }` rather than a module constant, so the whole
command table can be constructed against fakes.

### The one place a seam was not used

`CanvasStage.test.tsx` needs a _real_ frame to run, so it stubs `getContext` with
a permissive `Proxy` that returns a no-op for any unassigned property and stores
assignments:

```ts
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
  const assigned: Record<string, unknown> = { globalAlpha: 1 };
  return new Proxy(assigned, { … }) as unknown as CanvasRenderingContext2D;
});
```

This is the blunt instrument, used deliberately: the test asserts nothing about
what was drawn, only that a frame _ran_ without throwing and that React did not
re-render. A `Renderer` seam would have been more machinery for a claim that does
not need it.

The same file also takes control of `requestAnimationFrame` so that "a repaint was
requested" is countable - and restores it by hand rather than with
`vi.unstubAllGlobals()`, which would also tear down the `ResizeObserver` and
`matchMedia` stubs that `test/setup.ts` installs once for the whole run.

---

## 3. What is deliberately not tested

### Pixel output

No test asserts what a drawer painted. This is the largest deliberate gap and it
is a considered one.

Pixel assertions are brittle (antialiasing differs between platforms and browser
versions), expensive (they need a real canvas, so `node-canvas` or a headless
browser), and they fail for reasons that are not defects. Meanwhile the drawers
are thin - `drawRectangle` is a path plus a fill plus a stroke - and everything
_underneath_ them that could be subtly wrong is tested directly:

- the matrix the renderer pushes before calling a drawer (`matrix.test.ts`)
- the bounds used to cull it (`geometry.test.ts`)
- the text layout it paints (`text.test.ts`)
- the hit test that has to agree with what was painted (`hitTest.test.ts`)

The residual risk is a drawer that computes the right numbers and draws the wrong
shape. That failure is loud and immediate - you open the app and the rectangle is
an oval - which is exactly the class of bug a test is least needed for.

**What would close this gap** is a screenshot-diff suite in a real browser
(Playwright with a pinned rendering stack). It is not built: the maintenance cost
of a screenshot corpus is high and the bugs it catches here are ones you see on
first run.

### The browser's platform APIs

The IndexedDB backend (`services/idb.ts`) has no direct test. Its _contract_ is
tested through `createMemoryBackend`, and the interesting behaviour it adds on
top - resolving writes on `transaction.oncomplete` rather than
`request.onsuccess`, catching Safari's synchronous throw from `indexedDB.open`,
classifying `QuotaExceededError` - is reasoned about in comments and verified by
hand, not by a test. Testing it would mean either `fake-indexeddb` (whose
transaction-timing fidelity is precisely the thing in question, so it cannot
verify the one behaviour that matters) or a real browser.

That is an honest gap. The mitigation is that the layer is about 210 lines of code, every
failure is surfaced as a typed `Result` rather than swallowed, and the app has a
working fallback when it fails wholesale.

Likewise: image decoding, `toBlob` encoding, `URL.createObjectURL`, and the
`<a download>` mechanism in `download.ts` are all untested. Each is a thin wrapper
over a platform API where the wrapper is the trivial part.

### Layout

Nothing asserts a rendered element's size or position. jsdom does not do layout -
`getBoundingClientRect` returns zeros and `clientWidth` is always 0 - so it
_cannot_. See §4, which is what this costs.

### Third-party behaviour

No tests that React re-renders, that Zustand notifies subscribers, or that
`react-router` routes. `CanvasStage.test.tsx` looks like an exception and is not:
it tests _our_ claim about React's behaviour under _our_ subscription design.

### Coverage thresholds

There are none. Coverage is configured (`vitest run --coverage`, v8 provider) with
`src/main.tsx`, `src/types/**`, `src/constants/**`, and `*.d.ts` excluded, and the
config says why:

```
// Coverage is a signal, not a target. Excluded paths are either
// trivially declarative or exercised through integration tests.
```

A threshold gate would drive tests toward the cheapest uncovered lines - the
drawers and the barrel files - rather than toward the risky ones.

### Files with no direct test, worth naming

`executeIntents.ts` is the notable one. It was extracted from
`usePointerInteraction` specifically so that intent→store translation would be
"testable with no DOM", and **no test file for it exists yet**. The
machine that produces the intents is thoroughly tested and the store actions it
calls are thoroughly tested; the mapping between them is not. It is the highest-value
missing test in the codebase.

Also untested directly: `Renderer.ts`, `overlay.ts`, `background.ts`,
`usePointerInteraction.ts`, `useRenderer.ts` (beyond the `CanvasStage` assertions),
`useCanvasSize.ts`, `useProjectSession.ts`, `download.ts`, `demoProject.ts`, and
most presentational components.

---

## 4. The limit of the suite: `problems-log.md` entry 002

This is the most instructive thing in this document, and it is worth stating
without hedging.

**Every one of the 577 tests that existed at the time passed while the properties
panel was displaying 100% opacity as "10".** They would have kept passing. The bug
shipped to the first end-to-end run of the assembled editor and was found by
looking at it.

The mechanism:

- `AppearanceSection` computed the value correctly - `opacity * 100` - and passed
  `100` to `NumberField`.
- `NumberField` rendered `<input value="100">`. Correct.
- The panel was 256px wide (`w-64`) in a two-column grid. The cell was ~112px, the word
  label "OPACITY" took ~52px, the `%` suffix took another ~20px.
- `NumberField` had `min-w-0` on its input so it could shrink inside a flex row -
  which made the _input_ the most compressible thing in the row. It compressed to
  29 CSS pixels holding 38 pixels of content, and the browser clipped the last
  digit.

Live DOM measurement ended the investigation immediately:
`value: "100", clientW: 29, scrollW: 38, clipped: true`.

**No unit test could have caught this**, and it is important to be precise about
why. It is not that the test was missing. It is that:

1. **Every component in the chain behaved correctly.** There is no unit under
   test whose behaviour was wrong. A test of `AppearanceSection` asserting the
   multiplier is 100 passes. A test of `NumberField` asserting it renders its
   value passes. `PropertiesPanel.test.tsx` - 20 tests - asserts the field's
   value through the accessible name, and jsdom reports `"100"`, because that is
   what the DOM says. The DOM was right. The _pixels_ were wrong.
2. **jsdom does not lay out.** `clientWidth` is always 0 and
   `getBoundingClientRect` returns zeros, so the one measurement that reveals the
   bug is unavailable by construction. This is not a gap in the test suite; it is
   a gap in the environment the test suite runs in. Adding more tests of the same
   kind would not have helped at any number.
3. **The defect is emergent from a layout constraint**, not from a component. It
   appears only at a particular panel width, with a particular label length, with
   a particular font. It is a property of the composition, and the composition is
   only real in a browser.

The general lesson about the code - that `min-w-0` makes a flex child the thing
that yields, which is precisely backwards when that child is the only element
carrying information - is in `problems-log.md`. The lesson about _testing_ is:

> A green suite is evidence that the things you thought to check are still true.
> It is not evidence that the product works. Some classes of defect are only
> visible in a browser, and "the tests pass" is not a substitute for opening the
> thing.

The fix reflects this. `NumberField` now puts a `min-w-[4.5rem]` floor on the
field box and lets the _label_ truncate instead, so that when something must give,
it is the label - a clipped label still reads, and screen readers get it in full
regardless, whereas a clipped number is the field lying about the document. That
guard is designed to **never fire in practice**; the actual fix was to stop
pairing fields whose labels are words.

Neither half of that fix is verified by a test. Both are verified by looking.

### What this implies about where to invest next

The suite is well-shaped for logic and badly shaped for presentation, which is the
correct trade for a project whose hard parts are geometry and state. Closing the
remaining gap needs a _different kind_ of test, not more of the same:

- A real-browser smoke pass - load the editor, draw a shape, select it, check the
  properties panel shows the right numbers _and_ that no field is clipped
  (`scrollWidth > clientWidth` on any input is a one-line assertion that would have
  caught entry 002 outright, and would keep catching its whole family).
- Visual regression on the panels at the two or three widths that matter.

Neither is built. Both are named here rather than left as an implied claim that
the current suite is sufficient.

---

## 5. Conventions

**Tests sit beside their source**, `foo.ts` / `foo.test.ts`. No parallel
`__tests__` tree.

**Test names are sentences about behaviour**, not about implementation:

```
'holds the anchor fixed even when the requested zoom is clamped'
'records nothing for a click that moved nothing'
'reports an empty document rather than producing a blank image'
'does not re-render when the document changes'
```

Each names the bug it prevents. A test called `'zoomAroundPoint works'` tells a
future reader nothing about whether it may be deleted.

**Many test files carry a header comment stating what they do and do not claim.**
`png.test.ts`, `imageStore.test.ts`, `projectRepository.test.ts`,
`store.test.ts`, and `CanvasStage.test.tsx` all do. It is the cheapest place to
record a testing decision, because it is the file someone reads when they wonder
why the coverage stops where it does.

**The store is reset between cases.** `resetCanvasStore()` in `beforeEach` /
`afterEach`, because `useCanvasStore` is a module singleton.

**`src/test/setup.ts` stubs exactly two globals** - `matchMedia` and
`ResizeObserver` - because jsdom implements neither and both are load-bearing (the
renderer schedules on rAF; every responsive panel and the canvas itself size off a
`ResizeObserver`). They are stubbed unconditionally rather than behind a feature
check, since the DOM lib types declare both as always present and a guard would be
dead code the compiler can see through.

**Zero test-only dependencies beyond the runner and RTL.** No `fake-indexeddb`, no
canvas mock library, no MSW. Every fake in the suite is either a plain object
literal or a production implementation (`createMemoryBackend`).

**The gate is all four, every time:**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

`npm run verify` runs the lot.
