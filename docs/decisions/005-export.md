# ADR 005 - Export: reuse the renderer for PNG, serialize separately for SVG and JSON

**Status:** accepted, implemented
**Code:** `src/features/export/`, `src/features/project/serialize.ts`, `src/features/project/migrations.ts`

## Problem

A design tool that cannot get work out of it is a toy. Three audiences want three
different things: a raster image to paste into a document, a vector file to open
in another editor, and a project file that comes back in intact. Each has a
different fidelity contract, and the trap in all three is silence - an export that
produces a blank PNG, an SVG whose text has reflowed, or a JSON file that imports
as _nearly_ the original document, all fail without saying so. The user finds out
later, somewhere else.

There is a second problem underneath: whatever draws the export must not become a
second renderer. Two rendering paths drift, and the divergence shows up as "the
exported image doesn't match the screen" months after the code that caused it.

## Options considered

**One renderer, one output format.** PNG only, from the existing engine. Cheapest
and covers the most common case, but a canvas editor that cannot round-trip its
own documents has no backup story for browser storage that can be evicted
(ADR 004), and no path to another tool.

**An abstract drawing backend implemented twice.** Define a `DrawTarget`
interface - `moveTo`, `fill`, `stroke`, `text` - and implement it over Canvas 2D
and over SVG markup. One drawing path, two outputs, no drift by construction.

**A DOM/SVG-first architecture** where the editor renders SVG and PNG is produced
by rasterising it (`<foreignObject>`, `canvg`, or serialise-to-`Image`). Export
becomes nearly free and is perfectly faithful because the SVG _is_ the document.

**A library.** `html2canvas`, `canvas2svg`, `dom-to-image` and friends.

**Reuse the renderer for PNG, write a separate serializer for SVG, reuse the
storage schema for JSON.** Three mechanisms, one shared model.

## Decision

The last one.

- **PNG** - construct a `RenderScene` with a fitted viewport and bare chrome, point
  a second `Renderer` at an offscreen canvas, call `renderNow()`. No second
  drawing path.
- **SVG** - a separate element→markup serializer in `features/export/svg.ts`, with
  its fidelity limits documented in the module header and in `docs/export.md`.
- **JSON** - the same `SerializedProject` shape the IndexedDB record uses, with
  `schemaVersion` and a forward-only migration chain, differing from the storage
  format in exactly one respect: images are inlined as data URIs.

## Why

**PNG is nearly free because of ADR 001 and ADR 002.** The engine is a pure
function of `(scene getter, canvas)` - it holds no store handle, no subscription,
and no React. So exporting is:

```ts
const renderer = new Renderer(canvas, () => ({ ...scene, chrome: BARE_CHROME, backgroundColor }));
renderer.resize(plan.widthPx, plan.heightPx, 1);
renderer.renderNow();
```

That is the whole painting step, and it is a direct payoff of a decision made for
other reasons. With `react-konva` this would mean mounting a second hidden stage
or trusting the library's own serialisation; with a store-coupled renderer it would
mean faking a store.

Making chrome part of the _scene_ rather than a renderer flag is what keeps the
renderer a pure function of its input. The export builds a different scene; it
does not put a global renderer into a different mode and hope nothing else paints
in the meantime.

**The abstract backend was rejected because the two targets have genuinely
different primitives.** Canvas has no text layout engine and needs manual
wrapping; SVG has `<tspan>` and `text-anchor`. Canvas has no markers and needs
arrowhead geometry computed per arrow; SVG has `<marker>` with
`auto-start-reverse` and deduplicates fifty same-coloured arrows into one def.
Canvas is imperative state (`ctx.fillStyle =`); SVG is declarative attributes.

An interface over both is their _intersection_. It would mean hand-rolling in SVG
the things SVG does natively - emitting inline arrowhead paths instead of markers,
positioning every line by hand instead of using `text-anchor` - producing a worse
SVG file in exchange for one code path. And the drift it prevents is not
prevented anyway: the interface has to leak (`measureText` has no SVG equivalent),
so the leaks become the divergence instead.

Two implementations with a published list of differences is more honest and, in
this case, produces a better file.

**SVG-first was rejected on ADR 001's grounds**, not on export's. SVG nodes are
DOM nodes: the browser lays out and composites every one whether or not it is on
screen, there is no culling hook, and transforms on thousands of nodes thrash
style recalculation. Optimising the architecture for export fidelity at the cost
of the 60fps interaction path is the wrong trade for an editor. Rasterising SVG to
PNG also loses control of exactly the things that matter - font substitution,
`foreignObject` support, and canvas tainting rules around embedded images.

**A library was rejected** because `html2canvas` and friends solve "screenshot
arbitrary DOM", which is a much harder problem than the one here and is solved
approximately. We already have a renderer that draws the document exactly; using a
library to re-derive an approximation of it would be strictly worse.

**JSON shares the storage schema but not its population strategy.** The alternative
- one format for both - fails in one direction or the other. Inlining images in the
stored record would duplicate every photo into every autosave; referencing blobs by
key in an exported file would produce an export that breaks the moment it leaves the
machine. `serializeProject(project, images)` takes the map as a parameter, so the
repository passes `{}` and the export dialog passes data URIs. One schema, one
function, two callers.

**Versioning exists before it is needed.** `CURRENT_SCHEMA_VERSION` is 1 and the
migration chain is empty. The machinery is built and tested against a synthetic
v0→v1→v2 chain anyway, because the alternative is inventing it under pressure at
the first breaking change with real user files at stake. A file from a _newer_
version is refused outright rather than best-effort parsed: best-effort is the
worse failure, because the unknown fields are dropped silently, the user saves over
the file, and the data is gone.

**Failures are values, not exceptions.** `exportPng` returns
`Result<PngExportResult, PngExportError>` with four distinct kinds - `empty`,
`canvas-unavailable`, `render-failed`, `encode-failed` - because the UI says
something different for each and a `try`/`catch` is easy to omit and invisible
when omitted (ADR 004).

Two things were only obvious once the code existed:

- **Images must be decoded before the render.** `resolveImage` is synchronous by
  contract, because the frame loop cannot await; it returns `null` on a miss and
  starts a decode. On screen that is invisible - a placeholder is painted and the
  next frame has the pixels. **An export has no next frame**, so `renderNow()` on a
  cold cache silently produces a file with every image missing.
  `awaitImageDecodes` gates the render, with a re-check after subscribing (a decode
  can land in the window between the first probe and the subscription) and a
  5-second ceiling (the image store never re-notifies for a decode that already
  failed, so a missing blob would otherwise hang the export forever).

- **Canvas dimension limits do not throw.** Over the cap, `getContext` succeeds and
  every draw is discarded - there is no error to catch, so the scale must be
  clamped up front rather than attempted and recovered from. Both a per-side limit
  and a total-area limit apply, and the smaller wins; the area bound is a square
  root because area grows with the square of the scale. The clamp is _reported_,
  before the click in the dialog's estimate and afterwards in
  `PngExportResult.clampedFrom`, because "your 3× export quietly became 1.4×" is
  information the user needs and "here is a blank PNG" is not.

## Trade-offs

**SVG is not pixel-identical, and the divergences are specific.** Arrowheads are
sized by different rules - the canvas uses an absolute base that grows slightly
with stroke weight and is capped at 40% of the shaft, SVG uses
`markerUnits: 'strokeWidth'` with no absolute base and no cap, so a short thick
arrow exports with heads longer than its shaft. Text is a second greedy-wrap
implementation: it shares `measureText` so ordinary prose breaks identically, but
an over-wide word is character-broken on canvas and overflows in SVG, and the two
place the first baseline by different rules (a centred line box versus a fixed
0.8 × font-size offset). Fonts are referenced rather than embedded, so the file
reflows on a machine without the family. Every one of these is listed in
`docs/export.md §3` rather than discovered by a user.

**Two implementations means two places to update** when an element type is added.
The `assertNever` in `svg.ts` makes that a compile error rather than a silent gap,
which converts the risk from "forgotten" to "one more file to write".

**PNG is raster and its scale is fixed at export time**, offered as 1×/2×/3×.

**Export runs on the main thread.** A 3× export of a large document blocks until
`toBlob` resolves, with no progress beyond the button's loading state.
`OffscreenCanvas` in a worker is the next step and is not built - it would mean
the engine's `HTMLCanvasElement` dependency becoming `OffscreenCanvas`, which is a
real refactor for a case that is currently a second of blocking.

**Inlined images cost ~33%** over the raw bytes in a JSON export. Deliberate: a
self-contained file that survives being emailed is worth more than a smaller one
that does not.

**Migrations are forward-only and permanent.** A downgrade path does not exist,
and a migration can never be edited to change its output for inputs it already
handled - a v1 file can appear five years from now.

**JSON round-trips through this app's validator, not byte-for-byte.** Unknown
fields are dropped on import. That is the correct behaviour for untrusted input
and it means an exported file is not a lossless archive of a future version's
document.

## Consequences

- There is exactly one drawing path in the codebase. Anything the editor can draw,
  the PNG export can draw, and the two cannot drift.
- The renderer's `getScene` callback and the `SceneChrome` flags exist in the shape
  they do _because_ of export, and both make the engine easier to test as a side
  effect - a frame can be driven from a literal object.
- `planPngExport` is a pure function separated from the pixel work, which is what
  makes the padded bounds, the scale clamp, and the fitted viewport unit-testable
  under jsdom, and what lets the dialog show a live dimension estimate before the
  click (`docs/testing.md §2`).
- All three formats share `jsonFilename`'s slug rules, so naming is consistent and
  a project called `../../x` cannot become a download-path escape.
- Everything user-supplied in an SVG is escaped inside `tag()` rather than at each
  call site, so a new element mapping cannot forget it.
- Data URIs on import are checked against an allow-list before reaching an
  `<image href>` or an `Image.src`. A project file is untrusted input and an image
  field is the obvious injection vector.
- A missing image blob exports as a visible dashed placeholder rather than a hole,
  in both PNG and SVG - more honest than a gap the user discovers after sharing
  the file.
- The next formats, if wanted, are PDF (via an SVG→PDF step, inheriting the SVG
  fidelity limits) and clipboard image copy (`ClipboardItem` with the PNG blob,
  which is a few lines on top of `exportPng`). Neither is built.
