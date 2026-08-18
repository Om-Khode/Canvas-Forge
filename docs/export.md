# Export

Three formats, three completely different mechanisms, and one of them is not
pixel-faithful. This document says which and why.

Source of truth: `src/features/export/` (`png.ts`, `svg.ts`, `svgPrimitives.ts`,
`json.ts`, `download.ts`), `src/features/project/` (`serialize.ts`,
`migrations.ts`, `validate.ts`), `src/components/dialogs/ExportDialog.tsx`.
The decision record is `docs/decisions/005-export.md`.

| Format   | Mechanism                                             | Faithful?                  |
| -------- | ----------------------------------------------------- | -------------------------- |
| **PNG**  | The _same_ `Renderer`, pointed at an offscreen canvas | Yes, by construction       |
| **SVG**  | A separate element→markup serializer                  | No - see §3                |
| **JSON** | The serialized project document, images inlined       | Round-trips through import |

---

## 1. PNG - the payoff for keeping the engine React-free

There is no second renderer. The document is painted by the same `Renderer` the
screen uses, with a different scene and a different canvas:

```ts
function paintWithRenderer(
  canvas: HTMLCanvasElement,
  scene: RenderScene,
  options: PaintOptions
): void {
  const renderer = new Renderer(canvas, () => ({
    ...scene,
    chrome: BARE_CHROME,
    backgroundColor: options.background,
  }));
  try {
    renderer.resize(options.widthPx, options.heightPx, 1);
    renderer.renderNow();
  } finally {
    renderer.destroy();
  }
}
```

That is the entire painting step. It is possible because `Renderer` is
constructed with a `() => RenderScene` getter and holds no store handle, no
subscription, and no React anything (`engine/scene.ts`). It does not know or care
that the canvas is not on screen.

The consequence that matters: **the exported image cannot drift from what the
editor shows**, because there is only one drawing path. The usual way exported
images go wrong is a second renderer that gains a feature six months later than
the first one.

### The scene is different, the renderer is not

Three things are overridden.

**Chrome is suppressed.** On screen, the themed page colour and the dot grid _are_
the canvas. In a file they are decoration the user never drew, and a "transparent
PNG" that arrives with an opaque backdrop is simply wrong.

```ts
export interface SceneChrome {
  readonly background: boolean;
  readonly grid: boolean;
  readonly overlay: boolean; // selection outlines, handles, marquee
}
export const SCREEN_CHROME: SceneChrome = { background: true, grid: true, overlay: true };
export const BARE_CHROME: SceneChrome = { background: false, grid: false, overlay: false };
```

Making chrome part of the _scene_ rather than a renderer flag keeps the renderer
a pure function of its input. The export builds a different scene; it does not
put a different renderer into a different global state and hope nothing else
paints in the meantime.

**Selection and interaction are emptied.**

```ts
selectedIds: EMPTY_SELECTION,
interaction: IDLE_INTERACTION,
```

so no selection frame, handle, or marquee is baked into the file. The `png.test.ts`
suite asserts this by inspecting the scene handed to the paint function.

**`dpr` is 1.** The export's scale factor already lives in the viewport's `zoom`.
Folding it in twice would double every exported dimension - and would do so only
on retina machines, which is the worst kind of bug to ship
(`docs/coordinate-system.md §5`).

### The plan is pure, and separate

Everything computable without a canvas is split out:

```ts
export function planPngExport(bounds: Rect, options: PngPlanOptions = {}): PngExportPlan {
  const requestedScale = options.scale ?? 1;
  const worldBounds = expandRect(bounds, options.padding ?? DEFAULT_PADDING);
  const scale = clampScale(worldBounds, requestedScale, …);

  const widthPx  = Math.max(1, Math.round(worldBounds.width  * scale));
  const heightPx = Math.max(1, Math.round(worldBounds.height * scale));

  return { worldBounds, requestedScale, scale, widthPx, heightPx,
           viewport: viewportToFit(worldBounds, widthPx, heightPx, 0),
           clamped: scale < requestedScale };
}
```

Two reasons for the split. The export dialog shows a **live dimension estimate**
before the user clicks, so the plan has to be computable without doing the work.
And it is the only part testable under jsdom, which has no 2D context - see
`docs/testing.md`.

`viewportToFit(..., padding = 0)` is reused rather than writing `panX = -x * zoom`
inline, because "frame this rect in this many pixels" should have exactly one
implementation in the codebase. The padding argument is zero because
`worldBounds` already carries it. `png.test.ts` verifies the resulting viewport
maps the padded world rect exactly onto `(0,0)–(widthPx, heightPx)`.

`Math.max(1, ...)` is not defensive noise: a horizontal line has a zero-height
bounding box, and a zero-height canvas is a canvas that draws nothing.

### The canvas-dimension clamp

This is the trap that makes PNG export quietly produce a blank file.

```ts
const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_AREA = 268_435_456; // 16384²

function clampScale(bounds: Rect, scale: number, maxDimension: number, maxArea: number): number {
  if (bounds.width <= 0 || bounds.height <= 0) return scale;
  return Math.min(
    scale,
    maxDimension / bounds.width,
    maxDimension / bounds.height,
    Math.sqrt(maxArea / (bounds.width * bounds.height))
  );
}
```

**Browsers cap canvas size, and exceeding the cap does not throw.** `getContext`
succeeds, every draw is discarded, and `toBlob` returns an image of nothing. There
is no error to catch - which is precisely why the scale is clamped up front rather
than attempted and recovered from.

Chrome and Firefox accept 32767 on a side; Safari is lower and additionally
enforces a total-area budget. 16384 / 268M px is the largest pair that is safe
everywhere this app claims to run.

**Both constraints are applied, and the smaller wins.** A long thin document hits
the per-side limit first; a large square one hits the area limit first. The area
bound is a _square root_ because area grows with the square of the scale: to keep
`(w·s)·(h·s) ≤ A` you need `s ≤ √(A / (w·h))`.

**The clamp is reported, twice.** `PngExportPlan.clamped` drives a live warning in
the dialog before the click:

```ts
const clamped = plan.clamped
  ? ` · reduced to ${plan.scale.toFixed(2)}× to stay inside the browser's canvas limit`
  : '';
```

and `PngExportResult.clampedFrom` carries the originally requested scale
afterwards. "Your 3× export quietly became 1.4×" is information the user needs;
"here is a blank PNG" is not.

### Images must be decoded before the render

The subtlest bug in the export path, and it comes directly from a correct
decision made elsewhere.

`imageStore.resolveImage(key)` is **synchronous by contract**. It has to be - it
is called inside the draw loop, once per image element per frame, and a promise
there would either stall the frame or restructure the renderer around suspense.
So it returns whatever is decoded _now_, returns `null` on a miss, and kicks off a
decode in the background. On screen that is invisible: a placeholder is painted
and the next frame has the pixels.

**An export has no next frame.** `renderNow()` on a cold cache produces a file
with every image replaced by a dashed placeholder. Worse, it does so silently and
only for users whose cache happens to be cold - which is to say, anyone who
exports right after a page load.

```ts
export async function awaitImageDecodes(keys: readonly string[], deps: ImageDecodeDeps): Promise<void> {
  if (keys.length === 0) return;
  const pending = new Set(keys.filter((key) => deps.resolveImage(key) === null));
  if (pending.size === 0) return;

  await new Promise<void>((settle) => {
    …
    const unsubscribe = deps.subscribeImages((key) => {
      pending.delete(key);
      if (pending.size === 0) finish();
    });
    const timer = setTimeout(finish, deps.decodeTimeoutMs ?? IMAGE_DECODE_TIMEOUT_MS);

    // A decode started by the first `resolveImage` pass can land before the
    // subscription exists. Re-checking closes that window.
    for (const key of [...pending]) {
      if (deps.resolveImage(key) !== null) pending.delete(key);
    }
    if (pending.size === 0) finish();
  });
}
```

Three details, each of which is a bug if omitted:

- **The re-check after subscribing.** The first `resolveImage` pass _starts_ the
  decodes. If one lands between that pass and the `subscribe` call, its
  notification is missed and the export sits until the timeout. Without the
  re-check, exporting a warm cache is slow and exporting a fast cache is a
  five-second stall.
- **`imageStore` notifies on failure as well as success.** `startDecode`'s
  `finally` block calls `notify(key)` whether the decode resolved or threw, which
  is what lets a missing blob resolve the wait instead of stalling it.
- **The 5-second timeout is still needed.** `imageStore` remembers keys whose
  decode already failed and refuses to retry them - so a project referencing a
  blob that no longer exists would never produce another notification for that
  key at all. Without a ceiling, that export hangs forever.

The export proceeds after the timeout rather than failing, on the grounds that a
file with one placeholder is more useful than no file.

### Failures are values

```ts
export type PngExportErrorKind = 'empty' | 'canvas-unavailable' | 'render-failed' | 'encode-failed';

export async function exportPng(
  request,
  deps = {}
): Promise<Result<PngExportResult, PngExportError>>;
```

`Result<T, E>` rather than throwing, for the reasons in `services/result.ts`:
these are expected conditions in a browser app, and an unhandled `Result` is a
type error whereas a missing `try`/`catch` is invisible. Each of the four is
distinct because the UI says something different for each - "There is nothing to
export" is a different message from "The browser returned no PNG data."

`toBlob` resolving with `null` is handled explicitly. It is the callback's
documented failure signal, and treating it as success would download a
zero-byte file.

Hidden elements are filtered before planning, so an invisible element does not
inflate the export's bounds:

```ts
const elements = request.elements.filter((element) => element.visible);
```

---

## 2. JSON - schema versioning and the migration chain

The JSON export is the project document plus a version number:

```ts
export interface SerializedProject {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly viewport: Viewport;
  readonly elements: readonly SerializedElement[]; // nested forest, paint order
  readonly metadata: ProjectMetadata;
  readonly images: Readonly<Record<string, string>>; // data URIs by imageKey
}
```

**`elements` is a nested forest, not a flat array.** A group is written as
`{ type: 'group', …, children: [ … ] }` - its members inline, not by reference -
so the file mirrors the tree the store holds, and mirrors the `<g>` nesting the
SVG export emits.

Why the on-disk shape differs from the in-memory `{ byId, order }` is covered in
`docs/data-model.md §3`, including the part where groups **reverse** the original
argument: the flat array was chosen because an array cannot disagree with itself,
and a flat array carrying `childIds` can - an id listed inside a group and again
at the root describes two different trees. Nesting cannot express that state at
all. Same principle, opposite conclusion.

Writing the forest is a recursion over `childIds` and it carries a `visited` set,
for the same reason every walk in `features/elements/tree.ts` does: `childIds` is
data, so a store containing a cycle is a store that can exist, and writing one has
to terminate rather than recurse until the stack dies.

**Images are inlined as data URIs here and nowhere else.** The IndexedDB record
is written with `images: {}` because the blobs live in their own content-keyed
store (`services/projectRepository.ts`). Same schema, two population strategies:

- _Storage format_ references blobs by key. Ten projects using one photo store it
  once.
- _Export format_ inlines them. The file survives being emailed to someone whose
  browser has never seen the blob.

Conflating them would either bloat every autosave or produce an export that
breaks the moment it leaves the machine. The cost of inlining is base64's ~33%
overhead, which is a deliberate size-for-portability trade.

Only _referenced_ keys are carried over, so an export never ships pixels for an
image the user deleted:

```ts
for (const element of elementsInPaintOrder(project.elements)) {
  if (element.type !== 'image') continue;
  const dataUri = images[element.imageKey];
  if (dataUri !== undefined) referenced[element.imageKey] = dataUri;
}
```

The scan runs over the whole forest rather than the root order, or an image
inside a group would export without its pixels.

The file is written with two-space indentation rather than minified. An exported
project is something a developer might open, diff, or hand-edit, and the size
difference is rounding error next to the inlined images.

### Filenames

```ts
export function jsonFilename(projectName: string, extension = JSON_EXPORT_EXTENSION): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug.length > 0 ? slug : 'canvasforge-project'}${extension}`;
}
```

Unicode property escapes, so a project named in Cyrillic or Japanese keeps its
characters rather than becoming a row of hyphens. Everything else collapses to
hyphens, which incidentally strips `/`, `\`, and `.` - so a project named
`../../x` cannot become a download-path escape. `pngFilename` reuses it with a
different extension, so all three formats agree on naming.

### The migration chain

Every serialized project carries `schemaVersion`. On load it is walked forward one
version at a time, then validated:

```ts
export type Migration = (doc: unknown) => unknown;
/** Keyed by source version: `migrations[n]` upgrades a v`n` document to v`n+1`. */
export type MigrationChain = Readonly<Record<number, Migration>>;

export const migrations: MigrationChain = {
  /** v1 → v2: `elements` went from a flat array to a nested forest. */
  1: (doc) => stampVersion(doc, 2),
};
```

`CURRENT_SCHEMA_VERSION = 2`. **The machinery was built before it was needed**,
because the alternative is inventing it under pressure during the first breaking
change, with real user files at stake. It is also proven against a synthetic
v0→v1→v2 chain in `migrations.test.ts`, which is why `migrateDocument` takes the
chain and the target version as parameters rather than reading module constants.

The one real step so far is near-identity, and that is the interesting part
rather than a shortcut. v1's *shape* has no nesting: `elements` is already a flat
array, which is a valid v2 forest with every element a root and no `children`. A
hand-written v1 file that smuggles in a `type: 'group'` with no `children` array
is not the migration's problem - migrations assert nothing about their input, and
validation, which runs afterwards on the current-schema shape, is the only trust
boundary; it drops that element exactly as it would have post-migration. The step
still exists, is registered, and is tested, because a gap in the chain is a hard
error and "this version needs no work" is a claim that has to be made explicitly
rather than by omission.

Five failure modes are distinguished, because the UI says something different for
each:

```ts
export type MigrationErrorKind =
  'not-an-object' | 'missing-version' | 'newer-version' | 'missing-migration' | 'migration-failed';
```

**Migration is forward-only, and a newer file is refused outright.**

```ts
if (fromVersion > targetVersion) {
  return err({
    kind: 'newer-version',
    message: `This project was created with a newer version of CanvasForge (schema ${fromVersion}). …`,
  });
}
```

Best-effort parsing of an unknown format is the worse failure: unknown fields are
silently dropped, the user saves over the file, and the data is gone. Refusing
leaves the file intact.

**Migration and validation are separate passes, in that order.**

```ts
const migrated = chain ? migrateDocument(input, chain) : migrateDocument(input);
if (!migrated.ok) return err(migrated.error);
const validated = validateSerializedProject(migrated.value.doc);
if (!validated.ok) return err(validated.error);
return ok({ project: fromSerialized(validated.value.project), images: …, warnings });
```

A migration's job is to make an _old but well-formed_ document look current. A
validator's job is to defend against a _malformed_ one. If migrations also had to
cope with garbage, every future migration would re-implement half the validator.
Neither can absorb the other's job.

**The version is stamped once at the end**, regardless of what the migrations did:

```ts
function stampVersion(doc: unknown, version: number): unknown {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return doc;
  return { ...doc, schemaVersion: version };
}
```

The chain's contract is that each step bumps `schemaVersion`, but a migration that
forgets would leave the document looking older than it is and re-run the chain on
every load. Stamping makes that class of mistake unobservable.

**Migrations are permanent.** A v1 file can appear five years from now, so a
migration is never deleted and never edited to change its output for inputs it
already handled.

### Import

```ts
export function importProjectJson(text: string): Result<DeserializedProject, ImportError> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (cause) { return err({ kind: 'malformed-json', message: … }); }
  return deserializeProject(parsed);
}
```

`JSON.parse` is the one place a genuine throw is expected, so it is the one place
wrapped. Everything downstream returns `Result`.

Validation drops per element rather than aborting: a document with one broken
shape loads with the rest intact and reports what was dropped
(`docs/data-model.md §3`). Those warnings propagate to the UI through
`DeserializedProject.warnings` rather than being swallowed - a project that came
back with three elements missing is something the user must be told.

Two import-specific steps in `useProjectSession.importJson`:

```ts
// Inlined images become blobs before the document lands, so the renderer
// resolves them on the very first frame instead of drawing placeholders.
for (const [key, dataUri] of Object.entries(parsed.value.images)) {
  await images.putImageDataUri(key, dataUri);
}

// A fresh id: an imported file may carry the id of a project that already
// exists here, and reusing it would silently overwrite that project.
const imported: Project = { ...parsed.value.project, id: createId() };
```

Data URIs are checked against `ACCEPTED_IMAGE_TYPES` during validation before any
of this. A project file is untrusted input and an image field is the obvious
injection vector - an unchecked URI there admits `javascript:`, remote-tracking
`https:` beacons, and `data:text/html`.

**Nesting caps the depth, on two of the three untrusted-input paths.** A nested
document can no longer dangle or cycle, but it can nest tens of thousands deep
and blow the stack on any recursive walk. `MAX_GROUP_DEPTH` is **64**, enforced
at both places a file becomes a document: `validate.ts` drops and reports
anything deeper on the load path, and `services/projectRepository.ts` bounds
its own raw walk - the one that counts elements and sweeps image references
over records validation has not touched yet. A cap on only one of those two
would not be a cap.

Clipboard paste is a third untrusted-input path and has no depth cap.
`features/commands/clipboard.ts` `JSON.parse`s arbitrary clipboard text, and
each element goes through `validateElement.ts`, which - by design - validates
one element in isolation and has no notion of its own depth (see that
function's docblock). A pasted payload can therefore build an arbitrarily deep
tree that `tree.ts`'s walks, `layerRows.ts` and `serialize.ts` then recurse
over. This is a known gap, not closed here; it is on the follow-up list.

---

## 3. SVG - a separate serializer, and where it is not faithful

SVG is **not** the canvas renderer with a different backend. It is a separate
mapping from the element union to markup, which is why it lives in
`features/export/` and not in the engine. The renderer's job is pixels at 60fps;
this one's is a portable file. They share the _model_, not the code.

That is a deliberate choice with a real cost, and this section is the cost.

### Structure

Each element becomes a `<g>` carrying rotation, opacity, and an accessible name:

```ts
const attrs: Attrs = {
  transform: element.rotation === 0 ? null : `rotate(${fmt(degrees)} ${fmt(cx)} ${fmt(cy)})`,
  opacity: element.opacity >= 1 ? null : element.opacity,
};
return tag('g', attrs, title + shapeMarkup(element, markers, images));
```

Applying rotation and opacity uniformly on the wrapper rather than per shape type
means seven mappings do not each have to remember them. `<title>` is the group's
accessible name and its tooltip.

**A `GroupElement` becomes a real `<g>`, nested, and carries no `transform`.**

```ts
if (isGroup(element)) {
  const children = groupChildrenMarkup(store, element, markers, images, rendered);
  return tag('g', { opacity }, title + children);
}
```

A group two levels deep produces a `<g>` inside a `<g>`, mirroring the tree the
store holds rather than flattening it into paint order. The absent `transform` is
the design showing through the file format: a group owns no transform - they bake
into the members - and its `x`/`y`/`width`/`height` are a derived cache, so a
transform attribute here would attach geometry to a container that has none. The
branch never reads `element.rotation` for a group at all, rather than trusting the
always-zero invariant to hold. Group opacity composes correctly because it lands
on the wrapper and SVG's own group opacity semantics do the rest.

The recursion is structural over `childIds`, not a call into `tree.ts`'s
`walkChildren`, so it carries its own `rendered` set - **one** set for the whole
export, created in `elementsToSvg`, not one per root and not a clone per level. A
per-path set would stop a group containing itself but would miss the same id
reachable through two different paths (listed twice in one group's `childIds`, or
claimed by two separate groups). One shared set gives both guarantees, because an
id is marked rendered before the recursion descends into it.

Which array the exporters are handed is itself a decision with a test, in
`features/export/scope.ts`. PNG goes through the same `Renderer` the screen uses
and wants `elementsToPaint` - a flat array with ancestor opacity folded in and
hidden subtrees dropped. SVG and JSON rebuild the tree themselves and want the
*unfiltered* pool at every depth, because they apply a group's own opacity and
`visible` on their own: handing them the paint list would multiply group opacity in
twice, and pre-filtering by `visible` would promote a hidden group's members to
roots and export what the canvas refuses to paint.

The SVG frame is nonetheless computed over `elementsToPaint`, not over the roots.
A root can be a group, and a group's box is a derived cache of *every* descendant,
hidden ones included - framing on that would reserve room for content this very
export drops a few lines later, and would silently diverge from the dialog's own
size estimate.

Everything user-supplied - element names, text bodies, colours, alt text - is
escaped structurally, inside `tag()`, rather than at each call site:

```ts
out += ` ${key}="${escapeXml(typeof value === 'number' ? fmt(value) : value)}"`;
```

A project name containing `</text><script>` must produce literal characters, not
markup. Because the escape is in the tag builder, a new element mapping cannot
forget it.

Numbers are formatted to three decimals (`fmt`), which keeps files small with no
visible drift at export scale.

Arrowheads are `<marker>` defs, deduplicated by (style, colour) - fifty
same-coloured arrows emit one def, not fifty. Element bodies are serialized
_before_ `markers.defs()` is called, because the registry only knows which markers
were referenced once every element has been visited, and `<defs>` must precede its
references.

### Where it matches the canvas exactly

These were checked against the drawers, not assumed:

- **Freehand smoothing.** `svgPrimitives.smoothPathData` implements the identical
  quadratic-through-midpoints scheme as `drawers/freehand.ts`: each sample is a
  control point, each midpoint is an on-curve endpoint, and the tail closes with a
  straight segment to the final sample. The curve matches.
- **Dash patterns.** Both scale the pattern by stroke width
  (`STROKE_DASH_PATTERNS[style].map(d => d * strokeWidth)`), so a dashed hairline
  and a dashed 8px stroke read as the same _style_ in both outputs.
- **Corner radius.** Both clamp to `min(cornerRadius, width/2, height/2)`.
- **Caps and joins.** Both set round.

### Where it does not - stated, not hidden

**Arrowheads are sized by a different rule.** The canvas drawer computes

```ts
const headSize = Math.min(
  DEFAULT_ARROWHEAD_SIZE + element.strokeWidth * ARROWHEAD_STROKE_SCALE, // 12 + w·1.5
  shaftLength * ARROWHEAD_MAX_SHAFT_FRACTION // ≤ 40% of the shaft
);
```

- an absolute base that grows _slightly_ with stroke weight, capped so a short
arrow is not two overlapping heads. The SVG marker uses
`markerUnits: 'strokeWidth'` with `markerWidth: DEFAULT_ARROWHEAD_SIZE / 2`, which
is a head of `6 × strokeWidth` units with **no absolute base and no shaft-length
cap**. At the default `strokeWidth: 2` the two are close (12 units vs 15). At
`strokeWidth: 8` they diverge badly - 48 units in SVG against at most 24 on
canvas - and a short thick arrow that renders correctly on screen exports with
heads longer than its shaft.

The canvas drawer also insets the shaft to the base of a triangular head so the
round cap does not protrude past the tip; SVG's `refX: 9` approximates this but
does not reproduce it.

**Text is a second wrapping implementation.** `engine/drawers/text.ts` and
`export/svgPrimitives.ts` both implement greedy word wrap over the same
`measureText` with the same CSS font shorthand, so for ordinary prose in a browser
the line breaks agree. They are still two implementations, and they differ in two
respects:

- _An over-wide word._ The canvas breaks it at code-point boundaries
  (`splitOversizedWord`, which iterates the string so surrogate pairs are never
  split); the SVG serializer lets it overflow the box.
- _Vertical placement._ The canvas sets `textBaseline: 'middle'` and puts line `i`
  at `(i + 0.5) · fontSize · lineHeight`, centring each line in its own line box.
  The SVG serializer puts the baseline of line `i` at
  `fontSize · 0.8 + i · fontSize · lineHeight`. Line _spacing_ is therefore
  identical, but the first line's offset is derived by two different rules that do
  not coincide, and the discrepancy is a fraction of the font size rather than a
  sub-pixel amount. (The source comment in `svg.ts` describes this as sub-pixel
  drift; comparing the two formulas, that understates it.)

With no 2D context available at all - SSR, jsdom - the SVG measurer falls back to
an average glyph width (`0.52 × fontSize`) and the breaks are estimates.

**Fonts are referenced, not embedded.** Opening the file on a machine without the
family substitutes a fallback and reflows the text. Embedding would mean subsetting
and base64-ing font binaries into every export, which is a large amount of
machinery for a design-tool export that is usually opened on the same machine.

**Group opacity composites differently.** SVG `opacity` on a `<g>` flattens the
group and then blends it; the canvas multiplies `globalAlpha` and blends each draw
call separately. For a semi-transparent shape with both a fill and a stroke, the
seam where the stroke overlaps the fill blends twice on canvas and once in SVG. It
is subtle and it is real.

**Images stretch.** `preserveAspectRatio: 'none'`, matching the canvas drawer,
which also stretches to the element box rather than letterboxing - because the
box was authored by the user. Consistent between the two, and worth knowing.

**A missing blob becomes a visible placeholder** - a dashed rectangle - rather
than a hole:

```ts
if (href === undefined) {
  return tag('rect', {
    ...box(element),
    fill: 'none',
    stroke: '#b04a6a',
    'stroke-dasharray': '4 3',
  });
}
```

More honest than a gap the user only discovers after sharing the file. (The
canvas placeholder is a dashed rounded rect with a picture glyph; the SVG one is a
plain dashed rect. Not identical, deliberately - a placeholder is a signal, not
artwork.)

**Layer order is document order.** The SVG has no explicit z-index; elements are
emitted in `order` and SVG paints in document order. That is correct, and it means
hand-editing the file to reorder elements works exactly as expected.

### Why SVG is not "just another renderer backend"

The tempting design is an abstract drawing interface implemented twice -
`CanvasBackend` and `SvgBackend` - so there is one drawing path. It was not built,
for a concrete reason: the two targets have genuinely different primitives. Canvas
has no text layout engine and needs manual wrapping; SVG has `<tspan>` and
`text-anchor`. Canvas has no markers and needs arrowhead geometry; SVG has
`<marker>` with `auto-start-reverse`. Canvas is imperative state (`ctx.fillStyle =`);
SVG is declarative attributes.

An abstraction over both would be the intersection of the two, which means giving
up `<marker>` deduplication, giving up `text-anchor`, and hand-rolling in SVG the
things SVG does natively - producing a _worse_ SVG in exchange for one code path.
The honest version is two implementations and a documented list of where they
diverge, which is this section.

---

## 4. Getting the bytes to the user

```ts
export function downloadBlob(blob: Blob, filename: string): DownloadError | null {
  if (!canDownload()) return { kind: 'unsupported', … };

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.appendChild(anchor);   // Firefox ignores a click on a detached node
  anchor.click();
  anchor.remove();

  setTimeout(() => { URL.revokeObjectURL(url); }, REVOKE_DELAY_MS);
  return null;
}
```

There is no API for "save this to the user's disk" short of the File System Access
API, which Safari and Firefox do not implement. A synthetic `<a download>` click
against an object URL is the portable technique.

The subtlety is **when to revoke**. Revoking immediately after `click()` races the
browser's fetch of the blob - Firefox in particular starts the download
asynchronously and ends up with an empty file. Never revoking leaks the blob for
the document's lifetime, which for a 20 MB PNG matters. So: revoke on a 1-second
timer, after the navigation has been queued but soon enough that repeated exports
do not accumulate.

`downloadText` adds `;charset=utf-8` to the MIME type. Without it, a project name
with non-ASCII characters is decoded as latin-1 by some editors.

---

## 5. The dialog

`ExportDialog` owns _options_, not export logic. What it adds is the part that
only makes sense with a user in front of it:

- **A live dimension estimate** before the click - pixels for PNG, world units
  (content bounds plus twice the 24-unit padding) for SVG, an element count for
  JSON - recomputed from `planPngExportFor` / `contentBounds` as the scale and
  scope change.
- **The clamp, surfaced before the click**, not discovered afterwards.
- **A visible error afterwards**, in a `role="alert"`. An export that silently does
  nothing is the single most common way this feature ships broken.
- **Scope**: whole document or selection. The selection option is disabled when
  nothing is selected, and the scope resets to `document` each time the dialog
  opens with an empty selection.
- **Background**: on uses the current theme's canvas colour, off passes `null` for
  a transparent PNG or SVG. Not offered for JSON, which has no backdrop.

Image collection for SVG and JSON reads once per _distinct_ key rather than per
element, since the blobs are content-keyed:

```ts
if (element.type !== 'image' || images[element.imageKey] !== undefined) continue;
```

A key that cannot be read resolves to an empty string rather than failing the
whole export - the SVG serializer already draws a placeholder for it.

The dialog re-reads its format on each open, adjusting state during render rather
than in an effect, because it stays mounted between openings for its exit
animation. Without that, the palette's "Export PNG…" entry - which sets the format
immediately before opening - would appear to be ignored.

---

## 6. Limits

- **PNG is raster.** Scale is chosen at export time from `[1, 2, 3]` and cannot be
  changed afterwards.
- **Very large exports are silently reduced**, and the reduction is reported
  rather than hidden. Above ~16384px on a side, or ~268M pixels total, there is no
  export at the requested scale to be had.
- **SVG is not pixel-identical.** §3 lists every known divergence. The ones most
  likely to be noticed are thick-stroked arrowheads and text vertical placement.
- **SVG text reflows on machines without the font.**
- **JSON round-trips, but only through this app's validator.** Fields it does not
  recognise are dropped on import, silently by design - a file from a _newer_
  schema is refused rather than partially read, which is the only safe answer.
- **Export is synchronous with the main thread.** A 3× export of a large document
  blocks until `toBlob` resolves. There is no progress indicator beyond the
  button's loading state, and no worker offload - `OffscreenCanvas` in a worker
  would be the next step and is not built.
- **Nesting deeper than 64 is dropped on import**, not flattened. `MAX_GROUP_DEPTH`
  is a hostile-input cap, and nothing the UI can build comes close to it - but a
  hand-edited or machine-generated file that does loses the subtree past the cap,
  with a warning naming its path.
- **No PDF, no clipboard image export.** Both are plausible next formats; neither
  is built.
