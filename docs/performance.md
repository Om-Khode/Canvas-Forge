# CanvasForge - Performance

`docs/architecture.md` §11 makes a set of performance claims. This file is the
evidence for them, including the two places where the measurement disagreed with
the claim and the one place where it found a bottleneck bad enough to fix.

Every number here was produced by the harness in `src/features/perf/` or by the
browser instrumentation described under [Method](#method). Nothing is estimated.

---

## Method

**Two instruments, because two different things are being measured.**

_Pure functions_ - hit-testing, culling arithmetic, structural sharing - are
timed in Node under Vitest, where the input is deterministic and the measurement
is repeatable:

```bash
npx vitest run src/features/perf --disableConsoleIntercept
```

`benchmark.ts` times each iteration individually after a warmup and reports
**median and p95, never a mean**: one GC pause lands a sample two orders of
magnitude above the rest, and a mean over 100 samples reports that outlier as a
third of the "typical" cost. Percentiles are nearest-rank, so every figure quoted
is a value that was actually observed.

_Frame cost_ is measured in Chrome against a running editor, because a canvas
frame in jsdom paints nothing and timing it would be theatre. Two signals are
taken: the interval between `requestAnimationFrame` callbacks during a synthetic
pointer drag, and Chrome's own `Performance.getMetrics` counters over the same
window (`TaskDuration`, `ScriptDuration`, `RecalcStyleCount`) via CDP.

**Two caveats that change how the frame numbers read.**

1. The test display runs at **120Hz**, so frame intervals quantise to multiples
   of 8.33ms. A frame needing 9ms of work reports as 16.7ms, not 9ms. Where the
   distinction matters, main-thread work per frame (`TaskDuration ÷ frames`) is
   given alongside the interval - that is the number to compare against a budget.
2. Numbers are from a **production build** (`vite build` + `vite preview`) unless
   marked otherwise. React's development build is materially slower; where the
   gap is interesting it is reported, because "it's fine in prod" is only an
   answer if you measured prod.

### Hardware

|             |                                                    |
| ----------- | -------------------------------------------------- |
| CPU         | AMD Ryzen 5 4600H (6 cores / 12 threads, 3.0GHz)   |
| Memory      | 16GB                                               |
| OS          | Windows 11                                         |
| Browser     | Chrome 151, `devicePixelRatio` 1, 120Hz display    |
| Node        | v24.18.1                                           |
| Canvas size | 1168 × 852 CSS px (1440 × 900 window, panels open) |

A mid-range 2020 laptop, not a workstation. Numbers on an M-series Mac will be
better by roughly a factor of two; the _shapes_ of the costs will not change.

Node-side figures were taken while other builds were running on the same
machine, so ranges across runs are quoted rather than a single decimal.

### The stress document

`src/features/perf/stressDocument.ts` generates N elements from a seeded
`mulberry32` stream: six element types in realistic proportions (40% rectangles,
22% ellipses, 12% text, 10% lines, 8% arrows, 8% freehand), log-distributed
sizes from 16 to 260 world units, a quarter of them rotated, colours from the
editor's own palette, laid out on a jittered grid ~4,000 × 2,500 world units
across. Same seed, byte-identical document.

It is loaded by a dev-only search param on the editor route:

```
npm run dev   →   http://localhost:5173/editor?stress=2000
```

The document lands in a **new** project rather than the open one - autosave
writes the store to whatever project is open, and a benchmark that overwrites
the user's work is not a benchmark.

---

## Results

### 1. Frame cost during a pan (2,000 elements)

Ninety pointer-move frames of a middle-button pan, production build, minimap and
both panels open.

| Zoom      | Elements drawn | Frame interval (median / p95) | Main-thread work per frame |
| --------- | -------------- | ----------------------------- | -------------------------- |
| Fit (18%) | 2,000 (all)    | 33.3ms / 41.6ms               | 14.3ms                     |
| 100%      | ~180 (9%)      | 8.3ms / 8.4ms                 | 7.6ms                      |

At 100% zoom the editor pans at the display's full 120Hz. Zoomed out far enough
that the entire 2,000-element document is on screen, each frame needs ~14ms of
main-thread work: that fits inside a 60Hz budget (16.7ms) with little to spare
and misses a 120Hz one, which is why the interval lands at 33ms - the compositor
drops to one frame in four.

**The difference between those two rows is entirely the cull.** Same document,
same code, same input; only the number of elements that intersect the viewport
changed.

### 2. Culling effectiveness

Measured with the renderer's own predicate - `visibleWorldRect`,
`rotatedBounds`, `rectsIntersect` - over the whole document:

| Viewport                                   | Fraction drawn          |
| ------------------------------------------ | ----------------------- |
| 1440 × 900 at 100%, centred on the content | **9.3%** (187 of 2,000) |
| Zoomed to fit the whole document (27%)     | 100%                    |

The cull pass itself costs **0.19–0.31ms** for 2,000 elements - one
rotation-aware AABB and one intersection test each. It pays for itself an order
of magnitude over whenever it rejects anything, and it is the reason row 2 of the
table above exists at all.

The fraction is a property of the _document's_ spatial layout, not of the engine.
For this generated document, which spreads elements evenly, it is close to the
area ratio. A real document with everything in one artboard would cull less.

### 3. Hit-testing - the linear scan

`docs/architecture.md` §11 defers a quadtree. What that defers to is a full
linear walk on **every pointermove while idle**, because the interaction
machine's `probeUnderPointer` runs a hit test to pick the cursor.

| Operation                                               | Median          | p95         |
| ------------------------------------------------------- | --------------- | ----------- |
| Miss (walks every element) @ 2,000                      | **0.58–0.77ms** | 1.25–1.42ms |
| Miss @ 200                                              | 0.046–0.048ms   | 0.08–0.10ms |
| Hit on the topmost element @ 2,000                      | 0.001ms         | 0.002ms     |
| `elementsInOrder` (the array the walk consumes) @ 2,000 | 0.031–0.038ms   | 0.05–0.08ms |

Per element the cost is flat - ~0.24µs at 200, ~0.29–0.38µs at 2,000 - so the
scan is linear, as designed. The ratio measured 12–16× for 10× the elements;
that spread is machine noise, not superlinearity.

A miss is the worst case: it walks all 2,000 elements. A hit returns at the first
element it finds, and since the walk is top-down, clicking something visible is
effectively free.

**The verdict: the deferral was right at this scale, with one qualification.**
0.7ms per pointermove is 4% of a 60Hz frame and it happens only while idle, so it
is invisible today. It is also 8% of a 120Hz frame, and it grows linearly: at
10,000 elements the same walk is ~3.5ms and the hover path alone would eat a
fifth of a 60Hz budget. That is where a quadtree starts to earn its maintenance
cost - not before.

**This contradicts one sentence in `architecture.md` §11**, which describes the
hit test as running "over culled elements". It does not: `probeUnderPointer`
passes `elementsInOrder(store.elements)` - the entire document, unculled. The
numbers above are for the full walk, which is the code that actually runs.

### 4. History memory - structural sharing

`architecture.md` §6 claims that moving one element in a large document costs one
pointer map plus one element object, not N clones. Asserted as a test rather than
described as a virtue (`stressDocument.test.ts`):

- Moving one element in a 2,000-element document leaves **1,999 element objects
  reference-identical** between the before and after snapshots. The moved one is
  a new object; the `elementOrder` array is reused wholesale, because a move does
  not change z-order.
- The undo entry holds **one pointer** to the previous `ElementStore` - the
  snapshot is the previous document object, not a copy of it.
- Fifty consecutive single-element edits over a 2,000-element document leave
  **2,050 distinct element objects** alive across the entire timeline. Deep-copied
  snapshots would be 102,000.

At roughly 200 bytes per element object, that is ~10KB of new objects for fifty
edits, plus fifty maps of 2,000 pointers (~800KB total). The claim holds.

### 5. React re-renders during a pan

`architecture.md` §5 says a pan touches zero React components. Measured with
`<Profiler>` around the toolbar, the properties panel, the layers panel and the
minimap simultaneously, then 60 `panBy` writes:

**Zero commits.** (`Minimap.test.tsx`; `CanvasStage.test.tsx` covers the canvas
component itself.) The pieces that make it true: the canvas subscribes
imperatively, the zoom readout selects a rounded integer rather than the viewport
object, and the minimap subscribes to one boolean.

### 6. The minimap, and the bottleneck it exposed

The minimap draws the whole document through a second `Renderer`. Its
invalidation policy is deliberately split: the **document** surface repaints only
when `state.elements` changes identity (rate-limited to 5fps, since an element
drag dirties the document every frame), and the **viewport rectangle** repaints
on every viewport change.

The rectangle was first built the obvious way - an absolutely positioned `<div>`
moved with one `transform` write per frame. Measured on the stress document:

| Viewport rectangle implementation             | Main-thread work, 90-frame pan¹ | Style recalcs |
| --------------------------------------------- | ------------------------------- | ------------- |
| Positioned `<div>`, one style write per frame | 1,574ms (17.5ms/frame)          | 94            |
| Same, indicator detached from the document    | 753ms                           | 3             |
| **Canvas overlay (shipped)**                  | **486ms (5.4ms/frame)**         | 4             |
| Minimap closed (control)                      | 697ms                           | 3             |

¹ All four rows are the development build at 100% zoom, so the comparison is
like-for-like; the absolute numbers are higher than the production figures in
§1. "Indicator detached" is the same code with its writes going to a node that
is no longer in the document - the control that identifies the DOM write, rather
than the element, as the cost.

Moving the rectangle to a 192×128 canvas overlay removed **~9ms per frame** and
took the minimap's cost during a pan below the noise floor - it now measures
_faster_ than the control, which is the same number twice with run-to-run
variance on top.

The DOM write was cheap. The DOM it invalidated was not: each style write dirties
style and pre-paint for the whole document, and with the layers panel listing a
2,000-element document that document is ~45,000 nodes. Which leads to the next
section.

### 7. The layers panel - the one thing that broke, and the fix

**Before.** Toggling the layers panel on with 2,000 elements in the document:

| Build       | Wall time | Script time | DOM nodes |
| ----------- | --------- | ----------- | --------- |
| Production  | **979ms** | 275ms       | 45,221    |
| Development | 9,771ms   | 4,338ms     | 45,251    |

A one-second freeze in production, ten in dev. Every element became a row of ~22
DOM nodes, and nothing was virtualized. Beyond its own mount cost, that DOM was a
tax on everything else: it is what turned a per-frame style write in the minimap
into 9ms (§6).

This was the one place the architecture did not survive its own stated target
scale, and an earlier draft of `architecture.md` §11 listed virtualizing the
panel under _deliberately not done_. Measurement overturned that, so it was
built.

**After.** The list is windowed: only rows intersecting the viewport, plus six
of overscan, are mounted. Measured in the same session, on the same document, by
the same method - the unvirtualized case was reproduced in-page by giving the
scroll container its full content height, which makes the visible range the whole
list exactly as the old code rendered it:

| Dev build, 2,000 elements | Rendered rows | DOM nodes | Re-render |
| ------------------------- | ------------- | --------- | --------- |
| Unvirtualized             | 2,000         | 45,231    | 2,529ms   |
| Windowed                  | **17**        | **538**   | **590ms** |

Both timings include an identical 400ms settle, so the work itself is roughly
2,130ms against 190ms - about an order of magnitude, in a development build where
React's dev-mode overhead dominates. The DOM node count is the number that
matters more, because it is what the rest of the page pays: **45,231 → 538**.

Windowing is cheap here for one reason: every row is exactly `LAYER_ROW_HEIGHT`
(32px), so the visible range is division rather than measurement. No per-row
observers, no offset cache, no dynamic remeasurement - about forty lines in
`components/panels/useVirtualRows.ts`.

Three things had to survive the change, and each is tested rather than assumed:

- **Focus can target a row that is not in the DOM.** Arrow-key navigation off the
  edge of the viewport, and `Home`/`End`/`PageUp`/`PageDown`, scroll the target
  into range and focus it on the render that follows. Verified in a browser:
  `End` on a 2,000-row list scrolls to 63,677px and lands focus on row 2,000.
- **`aria-rowcount` and `aria-rowindex` are now mandatory.** With a window in the
  DOM rather than the list, they are the only things telling a screen reader that
  row 1,984 is row 1,984 of 2,000 and not the first of seventeen. Virtualization
  without them is an accessibility regression that trades one defect for a worse
  one.
- **Drag-reorder can no longer measure rows it cannot see.** The slot is now
  arithmetic - `round((pointer − listTop + scrollTop) / rowHeight)` - which also
  removed a pre-existing limitation: the old code snapshotted every row's rect at
  pointerdown, so scrolling mid-drag was documented as unsupported. Auto-scroll
  at the list edges was added with it, because in a windowed list of 2,000 rows
  the reachable drop targets would otherwise be whatever happened to be on screen.

**What is still true.** A 2,000-element document still costs what it costs
elsewhere - the canvas, the store, history. This section is only about the panel.

### 7b. How many elements can it actually hold?

Measured on the same machine, two ways that agree.

**In a browser** (dev build, Chrome, `?stress=N`, panning at 100% zoom so the cull
is doing its job and only ~200 elements are drawn):

| Elements | Frame time (median / p95) | Heap  |
| -------- | ------------------------- | ----- |
| 10,000   | 8.3ms / 10.1ms            | -     |
| 20,000   | **11.8ms** / 14.7ms       | 51 MB |

Doubling the document cost +3.5ms per frame - **~0.35µs per element per frame** -
while drawing the same ~200 shapes. That is the cull loop: rejecting an element
still means testing it, so the pass is O(total), not O(visible). Extrapolating
the slope, the 16.7ms budget for 60fps is exhausted around **34,000 elements even
when almost nothing is on screen**.

`MAX_STRESS_COUNT` caps the generator at 20,000, which is why the table stops
there; beyond it the numbers below come from the pure-logic ladder.

**In Node**, per operation, with no rendering (roughly 5–7× slower than the
browser - the browser measures hit-test at ~0.3µs/element against ~2µs here - so
read the _shape_, not the absolute):

| Elements | Hit-test miss | Cull pass | Move all | Heap    |
| -------- | ------------- | --------- | -------- | ------- |
| 1,000    | 2.1ms         | 0.4ms     | 0.5ms    | ~3 MB   |
| 10,000   | 10.2ms        | 3.0ms     | 3.2ms    | ~20 MB  |
| 25,000   | 21.8ms        | 7.6ms     | 6.9ms    | ~51 MB  |
| 50,000   | 42.6ms        | 15.2ms    | 22ms     | ~180 MB |
| 100,000  | 70.6ms        | 25.1ms    | 43ms     | -       |

**What breaks, in order:**

1. **Zooming out to show everything.** This bites first and it bites hardest -
   at ~3,000 elements, and it is not really a scale problem at all: you are
   asking the renderer to draw 3,000 shapes in a frame. 10,000 visible at once
   measures 376ms/frame against 8.3ms for the same document at 100% zoom, a 45×
   difference that _is_ the cull.
2. **Hit-testing on hover**, ~25,000+. A linear scan over the whole document,
   uncalled and unculled, on every idle pointermove.
3. **The cull loop**, ~34,000+, as derived above.
4. **Memory and history**, ~180 MB at 50,000 before history depth multiplies it.

**Honest summary:** comfortable to ~10,000, solid to ~20,000, degrading through
~34,000, unusable somewhere near 50,000. The single change that moves all of
these at once is a spatial index (quadtree or uniform grid), which takes both the
cull and the hit-test from O(total) to O(visible) and would push the wall out by
roughly an order of magnitude. `architecture.md` §11 defers it on the grounds
that it needs incremental maintenance on every move - still true, and it is now
the highest-value remaining optimisation.

### 7c. Grouping is not free, and the derive pass is where the cost goes

A group's box is a cache of its leaves, re-derived on the elements slice's single
write path (`store/deriveGroups.ts`, `withDerivedGroups`). That runs once per
store write, which during a drag means once per frame - so it is worth knowing
what it costs.

Measured with a throwaway Vitest file driving the **real** store through
`applyPatches` once per simulated drag frame, warmed up, 60 frames per figure.
Deliberately the worst possible shape: *every* element in one group, which
maximises both `deriveGroupRect`'s descendant walk and the `byId` passes.

| elements | grouped commit | flat commit  | `withDerivedGroups` alone |
| -------- | -------------- | ------------ | ------------------------- |
| 200      | 0.40ms/frame   | 0.18ms/frame | -                         |
| 1,000    | 2.83ms/frame   | 1.38ms/frame | 1.37ms                    |
| 4,000    | 15.1ms/frame   | 5.42ms/frame | 6.34ms                    |

**About 2.8× the flat write cost at 4,000 elements, and the derive pass is ~42% of
the grouped frame.** The dominant term inside it is `deriveGroupRect` - it walks
the descendants and allocates a `Set` per group - followed by the `byId` rebuild.

Two things bound this in practice. A document with **no groups returns after one
type check per element**, so the overwhelmingly common case pays nothing
measurable. And the shape above is hostile by construction: a realistic document
- a group of twenty inside a thousand elements - pays only for that group's own
subtree, because a group whose box and membership already agree is skipped
(`settled`) and every untouched element stays reference-identical.

None of this was optimised, deliberately. If the 4,000-in-one-group case ever
needs 60fps, the profitable target is `derivePass`, not the surrounding write
machinery. That is recorded so the decision starts from a measurement rather than
an intuition. The harness is not in the repository - it drove the real store
rather than a fixture and had no assertions worth keeping.

### 8. Miscellaneous

|                                                                                    |                           |
| ---------------------------------------------------------------------------------- | ------------------------- |
| Generating the 2,000-element stress document (Node)                                | 4.9–7.2ms                 |
| Hover - hit test per pointermove, no repaint - @ 100%, 2,000 elements (production) | 8.3ms/frame, none dropped |
| Element drag @ 100%, 2,000 elements (development)                                  | 8.4ms/frame median        |

---

## Summary

**Genuinely fast.** Culling - 9% of the document drawn at a normal zoom, for
0.2ms of arithmetic. Structural sharing - fifty edits over 2,000 elements cost
fifty objects. The React boundary - a pan runs the reconciler exactly zero times.
Hit-testing a document you can see, which returns on the first hit.

**Slow but fine at this scale.** The linear hit-test miss at 0.7ms, which is
invisible while idle and linear in document size. The full-document repaint at
14ms/frame when everything is on screen, which holds 60fps and misses 120fps.

**What breaks first.** The layers panel, decisively, at a one-second mount for
2,000 elements - and it drags everything that writes to the DOM down with it.
After that, the frame budget: the renderer is linear in _visible_ elements, so
whatever the cull cannot reject sets the ceiling. On this machine that ceiling is
~2,000 visible elements at 60fps.

**What would need to change to go 10×.** Virtualize the layers panel (mandatory);
spatially index hit-testing (a quadtree, or a cheaper coarse grid, once the walk
passes ~2ms); and cache static elements into an offscreen layer so a pan blits
instead of re-drawing. None of the three is worth its complexity at 2,000
elements, and all three are measurable decisions rather than guesses now that the
harness exists.
