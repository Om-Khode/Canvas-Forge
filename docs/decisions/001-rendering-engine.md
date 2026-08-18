# ADR 001 - Rendering engine: hand-rolled Canvas 2D

**Status:** accepted, implemented
**Code:** `src/features/canvas/engine/`

## Problem

An infinite-canvas editor has to draw an unbounded document at arbitrary zoom, hit-test rotated shapes under the cursor, and stay at 60fps while the user drags. The rendering substrate determines almost everything downstream: how selection is implemented, how export works, how many elements the app survives, and how much of the interesting logic is ours versus a library's.

## Options considered

**DOM elements, one node per shape.** Absolutely viable up to a few hundred elements, and it comes with accessibility and hit-testing for free. Falls over past that: the browser lays out and composites every node whether or not it's on screen, and there is no culling hook. Transforms on thousands of absolutely-positioned nodes thrash style recalculation.

**SVG.** Same free hit-testing, plus resolution independence and a trivial path to SVG export. Same scaling problem as the DOM - SVG nodes are DOM nodes - and text metrics and freehand smoothing get harder rather than easier.

**Konva or Fabric.js.** Scene-graph libraries over Canvas 2D. They provide the retained-mode object model, hit-testing via a hidden colour-keyed buffer, and - in Konva's case - a ready-made `Transformer` with resize and rotate handles. `react-konva` gives a React reconciler for the scene graph.

**Hand-rolled Canvas 2D.** Immediate mode: an `rAF` loop that clears and repaints the visible region each frame, with our own transform stack, hit-testing, and overlay chrome.

## Decision

Hand-rolled Canvas 2D, in `src/features/canvas/engine/`, with no scene-graph dependency.

## Why

The decisive argument is that the parts a scene-graph library owns are exactly the parts worth owning here.

This is a portfolio project whose explicit purpose is to be discussed in a technical interview. "How do you hit-test a rotated rectangle?" has two possible answers. One is _"invert the element's affine matrix, transform the pointer into the element's local space, and test against the axis-aligned shape - which means rotation needs no per-type special case at all."_ The other is _"Konva's `Transformer` handles that."_ The first answer is the project. Choosing the library optimises for shipping a feature and against being able to explain it.

It is also less code than it sounds. The engine is 1,665 non-test lines - matrix maths, hit-testing, seven drawers, background, overlay, theme, and the frame loop - and a substantial fraction of that is the comments explaining the derivations. Konva is ~150KB minified before `react-konva` (their figure, not measured here). For comparison, the shared entry chunk here is 102KB gzipped and the code-split editor route adds a further 48KB, so a visitor who never opens the editor downloads neither it nor an engine.

Two secondary benefits turned out to matter more than expected:

**PNG export is nearly free.** The engine is a pure function of `(elements, viewport, target canvas)` with no React and no store dependency - it takes a `getScene()` callback and knows nothing about where the data lives. Exporting means constructing a scene with a fitted viewport and an offscreen canvas and calling `renderNow()`. With `react-konva`, export means either mounting a second hidden stage or using the library's own serialisation, both of which are more machinery than this.

**`react-konva` would need its own explanation.** It introduces a second reconciler alongside React DOM, with its own rules about when the scene graph re-renders. That is a real source of performance surprises, and defending it in an interview means understanding a library's internals rather than one's own design.

## Trade-offs

**What we gave up.** Konva would have delivered working resize/rotate handles on day one; ours took a bounds module, a handle-geometry module, and an overlay pass. Its colour-keyed hit buffer is pixel-exact for complex paths, whereas our analytic hit-test approximates freehand strokes by their sample points (documented in `hitTest.ts` - the smoothed curve deviates by at most half a sample spacing, comfortably inside the click tolerance).

**Canvas is not accessible.** A `<canvas>` is opaque to a screen reader. This is inherent to the choice, and the mitigation is architectural rather than cosmetic: the layers panel is a real, keyboard-navigable list that is the document's accessible representation, and every canvas operation has an equivalent in the surrounding DOM UI. Had we chosen SVG or DOM, some of that would have come free.

**Text is the hardest part.** Canvas has no layout engine. Wrapping, line height, and caret positioning are ours to implement, and the measurement used for rendering has to be the same measurement used by the editing overlay or the caret drifts from the glyphs. The engine exports `wrapText` taking a structural measurer for exactly that reason, and the editing overlay consumes it.

There is one deliberate exception, and it is a real cost rather than an oversight: the SVG exporter has its **own** `wrapText` in `svgPrimitives.ts`, because `features/export` is not allowed to depend on `features/canvas`. The two implementations agree on ordinary text and diverge on over-wide single words and on first-baseline placement - canvas draws with `textBaseline: 'middle'` at `(i + 0.5) · fontSize · lineHeight`, SVG places its baseline at `0.8 · fontSize + i · fontSize · lineHeight`. The gap is a fraction of the font size, not sub-pixel. It is the price of the layering rule, it is enumerated in `docs/export.md`, and the honest options are to accept it or to move text measurement into a shared module below both - which is the fix if the divergence ever matters.

**No free retained-mode invalidation.** We repaint the visible scene each dirty frame rather than tracking per-node dirty regions. Mitigated by rAF coalescing (N store writes produce one paint) and viewport culling (cost tracks what's on screen, not what exists).

## Consequences

- The engine directory is pure TypeScript and imports no React and no store. This is enforced by review and stated in the layering table in `docs/architecture.md`; it is what makes both offscreen export and unit-testing the maths possible.
- Drawers are one small pure function per element type behind a dispatcher ending in `assertNever`, so adding an element variant is a compile error until every site handles it.
- Selection chrome is drawn in a separate overlay pass with the viewport transform reset, so handles stay 8 screen pixels at every zoom level instead of scaling with the document.
- Each element's draw call is wrapped so a single malformed element cannot blank the canvas - a requirement the spec states and that immediate-mode rendering makes easy to honour.
- At a scale where linear hit-testing over culled elements stopped being fast enough, the next step is a spatial index (quadtree or grid). Not built: it needs incremental maintenance on every move, and nothing measured so far justifies it.
