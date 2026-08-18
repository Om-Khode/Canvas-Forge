# Data model

The shape of a document, and why it is shaped that way.

Source of truth: `src/types/element.ts`, `src/types/project.ts`, `src/types/geometry.ts`.

---

## 1. The element union

Every element is a member of one discriminated union, keyed on `type`:

```ts
export type CanvasElement =
  | RectangleElement
  | EllipseElement
  | LineElement
  | ArrowElement
  | TextElement
  | ImageElement
  | FreehandElement
  | GroupElement;
```

Eight variants - seven that draw and one container. Each shares a common base:

```ts
export interface BaseElement {
  readonly id: ElementId;
  readonly type: ElementType;
  /** User-facing label in the layers panel. Auto-generated, renameable. */
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Radians, clockwise, about the element's centre. */
  readonly rotation: number;
  /** 0..1 */
  readonly opacity: number;
  readonly locked: boolean;
  readonly visible: boolean;
}
```

`x`/`y` are the top-left corner of the element's **unrotated** box, in world
units. `rotation` is applied about the box's centre at draw and hit-test time
and is never baked into the position. That separation is what lets move,
resize, alignment, and distribution work on plain axis-aligned arithmetic and
confines the angle to the transform stack (`engine/matrix.ts`) and to the two
places that need a rotation-aware AABB (`utils/geometry.rotatedBounds`).

Paint properties are mixed in through two small interfaces rather than repeated
per variant, which is also what makes the derived types below possible:

```ts
export interface StrokeProps {
  readonly stroke: string | null; // null = no stroke
  readonly strokeWidth: number;
  readonly strokeStyle: StrokeStyle; // 'solid' | 'dashed' | 'dotted'
}

export interface FillProps {
  readonly fill: string | null; // null = hollow
}
```

`null` rather than `'transparent'` or an extra boolean: a hollow shape is a
different _state_, and hit-testing branches on it - a filled rectangle is
clickable anywhere inside, a hollow one only near its outline
(`engine/hitTest.ts`, `containsLocalPoint`).

### Derived narrowings, not second lists

```ts
export type FillableElement = Extract<CanvasElement, FillProps>;
export type StrokableElement = Extract<CanvasElement, StrokeProps>;
export type LinearElement = LineElement | ArrowElement;
```

`Extract` over the union rather than a hand-written `RectangleElement |
EllipseElement`. A hand-written list is a second source of truth about which
variants carry a fill, and it silently goes stale the day an eighth variant is
added.

### Why a discriminated union, and why `assertNever`

The alternative designs are a class hierarchy with virtual `draw()`/`hitTest()`
methods, or one wide struct with mostly-null fields.

A class hierarchy is the "obvious" OO answer and it is wrong here for a specific
reason: elements have to be serialized, structurally shared between history
snapshots, and compared by reference. Plain data does all three for free; class
instances need a revival step on load, and a `clone()` that is easy to get
subtly wrong. It also puts rendering inside the model, which is exactly the
coupling the engine/store split exists to avoid.

A wide struct removes the exhaustiveness checking that is the union's whole
point: `element.cornerRadius` would type-check on a `LineElement`.

The union's payoff is `assertNever`:

```ts
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
```

Placed in the `default` branch of every `switch` on `element.type`. If a variant
is added, the argument stops being `never` and **the file fails to compile** -
at every site that must learn to handle it. Today that is:

| Site                          | File                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Drawer dispatch               | `features/canvas/engine/drawers/index.ts`                                                |
| Per-type hit test             | `features/canvas/engine/hitTest.ts`                                                      |
| SVG serialization             | `features/export/svg.ts`                                                                 |
| Validation of untrusted input | `features/project/validate.ts` (a `switch` with no `default`, exhaustive by return type) |
| Draft geometry patch          | `features/canvas/interaction/executeIntents.ts`                                          |

Adding a variant is therefore a compile error five times over, rather than a
runtime gap discovered by a user. The cost is one throw statement and the
discipline to never write `default: break`.

`assertNever` throwing is deliberate, and it belongs to the small set of things
this codebase treats as _programmer_ error rather than as a runtime condition -
the others being a missing 2D context in `Renderer`'s constructor, a duplicate
command id or malformed chord string in the shortcut registry, and a missing
`#root` element in `main.tsx`. Each means the build is wrong, and crashing loudly
is the correct behaviour.

Everything that is an _expected_ failure - storage full, corrupt file, encode
failed, image decode refused - returns `Result<T, E>` instead. See
`services/result.ts` and `docs/decisions/004-persistence.md`.

---

## 2. The variants

### Rectangle and ellipse

```ts
export interface RectangleElement extends BaseElement, StrokeProps, FillProps {
  readonly type: 'rectangle';
  /** World units. Clamped at draw time to half the shorter side. */
  readonly cornerRadius: number;
}

export interface EllipseElement extends BaseElement, StrokeProps, FillProps {
  readonly type: 'ellipse';
}
```

`cornerRadius` is stored unclamped and clamped at draw time. Storing the clamped
value would mean that shrinking a rectangle and growing it again loses the
radius the user set - the clamp is a rendering concern, not a fact about the
document.

### Lines and arrows carry a bounding box

```ts
export interface LineElement extends BaseElement, StrokeProps {
  readonly type: 'line';
  readonly start: Vec2; // normalized 0..1 within the box
  readonly end: Vec2;
}

export interface ArrowElement extends BaseElement, StrokeProps {
  readonly type: 'arrow';
  readonly start: Vec2;
  readonly end: Vec2;
  readonly arrowheadStart: ArrowheadStyle;
  readonly arrowheadEnd: ArrowheadStyle;
}
```

The obvious model for a line is two world-space endpoints and no box. That model
costs you a special case in seven places: selection bounds, marquee
intersection, alignment, distribution, the resize handles, the properties
panel's W/H fields, and export framing all want a rectangle.

Storing a box plus **normalized** endpoints (0..1 within the box) means a line
goes through exactly the same transform path as a rectangle. `resizeElements`
patches only `{x, y, width, height}`; the endpoints are fractions and follow for
free. `rotateElements` patches `rotation` and the centre; the endpoints are in
local space and follow for free. One transform implementation, not two - see
`features/elements/operations.ts`, which has no line-specific branch anywhere in
its resize or rotate paths.

The cost is that the endpoints must be denormalized wherever the absolute
positions are needed. That happens in exactly three places, and each does the
same two multiplies:

```ts
// engine/hitTest.ts - local space, so the box origin is already (0,0)
const start = { x: element.start.x * element.width, y: element.start.y * element.height };

// export/svg.ts - world space, so the box origin is added back
x1: element.x + element.start.x * element.width,
```

The direction of the drag is information the box alone has thrown away -
dragging bottom-right→top-left and top-left→bottom-right produce the same box
with mirrored endpoints. That is why `createLine`/`createArrow` take two points
rather than a rect (`features/elements/factory.ts`).

`FreehandElement` uses the same scheme with an array:

```ts
export interface FreehandElement extends BaseElement, StrokeProps {
  readonly type: 'freehand';
  readonly points: readonly Vec2[];
}
```

A degenerate axis is the failure mode here - a perfectly horizontal stroke has a
zero-height box, and normalizing divides by it. `boundsOfPoints` widens the
degenerate axis to `MIN_ELEMENT_SIZE` and re-centres, so the division is always
safe and the stroke is always grabbable.

### Text

```ts
export interface TextElement extends BaseElement {
  readonly type: 'text';
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: FontWeight; // 400 | 500 | 600 | 700
  readonly italic: boolean;
  readonly textAlign: TextAlign;
  /** Multiplier of font size, not an absolute value. */
  readonly lineHeight: number;
  readonly color: string;
  readonly autoHeight: boolean;
}
```

Three decisions here are load-bearing.

**`lineHeight` is a multiplier, not pixels.** Changing the font size from 20 to
48 with an absolute leading of 27px produces overlapping lines. As a multiplier
the visual leading survives a size edit, which is what a user expects and what
CSS does. `measureTextBlock` computes `lineHeightPx = fontSize * lineHeight`
once, in `engine/drawers/text.ts`.

**`color` rather than `fill`.** Text has no stroke in this model, and calling
its colour `fill` would put it in `FillableElement`, which would make the
properties panel offer a fill swatch and a stroke swatch for a text element -
one of which does nothing. The separate name keeps the type-level narrowing
honest.

**`autoHeight` exists because there are two different height semantics and no
single field can express both.** A text box whose height tracks its wrapped
content behaves correctly while you type but cannot be resized vertically. A
text box with a user-set height behaves correctly under a resize handle but goes
stale the moment the content or the font size changes. Both are wanted, at
different moments, and the _only_ thing that distinguishes them is user intent.
So intent is stored:

- `true` - the height is derived. `measureTextBlock().height` is authoritative
  and the box follows the content.
- `false` - the height is data. The user dragged a vertical handle and now owns
  it; content that overflows overflows.

`createText` starts every text element at `autoHeight: true`, with the initial
height floored at one line (`fontSize * lineHeight`) so a click-to-place box is
never zero-height. The validator defaults a missing `autoHeight` to `true` for
the same reason: derived is the recoverable state, user-set is not.

The alternative - a nullable `height` where `null` means auto - was rejected
because `height` is on `BaseElement` and every other consumer (culling, bounds,
alignment, resize) would then have to handle a null height. A boolean beside a
number keeps the null out of the hot paths.

### Images hold a key, never pixels

```ts
export interface ImageElement extends BaseElement {
  readonly type: 'image';
  readonly imageKey: string;
  /** Intrinsic pixel dimensions, kept so aspect ratio survives a reload. */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  /** Falls back to the filename; used as the accessible label. */
  readonly alt: string;
}
```

`imageKey` is a content hash - `sha256-…`, or `fnv-…` when `crypto.subtle` is
absent outside a secure context (`services/imageStore.ts`). The blob lives in
its own IndexedDB store under that key.

Three consequences follow, and each of them is the reason:

1. **History stays small.** A history entry is a snapshot of the document
   (`docs/history.md`). If an `ImageElement` carried its pixels, every entry
   touching an image document would retain megabytes. It carries a ~70-character
   string instead.
2. **Deduplication is automatic.** The key is the hash of the stored bytes, so
   the same photo dropped ten times is one blob and one decode. An id-based key
   would store ten copies.
3. **Blobs are shared across projects**, which is why deletion is a mark-and-sweep
   over surviving projects rather than a per-project delete
   (`services/projectRepository.ts`, `deleteProject`).

The hash is taken _after_ downscaling, so the key identifies the bytes actually
stored - otherwise the same photo uploaded at two source resolutions would hash
differently despite producing identical stored blobs.

`naturalWidth`/`naturalHeight` are kept on the element so aspect-ratio lock works
before the blob has decoded. Without them, a reload would show correct geometry
only after an async round trip.

**The limitation, plainly:** the element is only meaningful next to the blob
store. Copy an `ImageElement` into a different browser profile and it renders a
placeholder. That is precisely why the _export_ format inlines images as data
URIs and the _storage_ format does not - see `docs/export.md`.

### Groups hold membership, and no transform of their own

```ts
export interface GroupElement extends BaseElement {
  readonly type: 'group';
  /** Members, bottom-to-top within the group. */
  readonly childIds: readonly ElementId[];
}
```

The full argument is `docs/decisions/006-grouping.md`. The parts that are facts
about the model:

**A group has no transform.** Members keep the world coordinates they already
had, which is why grouping and ungrouping are invisible on screen. Transforming
a group writes the transform into every descendant - group transform and
multi-selection transform are literally the same call into
`features/elements/operations.ts`.

**`x`, `y`, `width`, `height` are a derived cache**, not authored values: the
axis-aligned union of the group's *leaf* descendants. A nested group contributes
nothing of its own, because its members are already in that union and counting
its cached box too would double-weight them. `rotation` is 0 - rotating a group
turns the children and leaves the group's box axis-aligned, which matches
`selectionBounds` already returning `rotation: 0` for a multi-selection.

Storing derived values in the same fields as authored ones is a real wart. The
alternative is a narrower base type for groups, which makes the union
non-uniform and forces narrowing at every `element.x` in the codebase. The union
stays uniform, and drift is prevented in exactly one place instead:
`withDerivedGroups` in `src/store/deriveGroups.ts`, on the elements slice's
single write path. Three invariants live there, each enforced once:

1. A group's box is re-derived from its leaves.
2. A group always has at least one live member; the last one leaving dissolves
   it, transitively.
3. Every element has exactly one home - one parent group, or the root order,
   never both and never two parents.

**The consequence to know before touching the transform path:** a patch that
names a group's own `x`/`y` is recomputed away inside the same synchronous
write, so the gesture appears to do nothing at all. The leaves are the only
elements holding real geometry, and `features/selection/resolve.ts`'s
`transformSet` is what expands a selection down to them.

**`locked` and `visible` become inherited.** A member of a locked group is not
selectable and a member of a hidden group is neither drawn nor hit-tested,
neither of which is recorded on the member. `effectiveLocked(id)` and
`effectiveVisible(id)` walk to the root; this is the one place where an
element's own flag stops being the whole answer.

**View state is deliberately not on the element.** `collapsedGroupIds` and
`enteredGroupId` live in the `ui` slice, because on the element they would
serialize into the saved file and enter history - making *expanding a group* an
undoable action.

---

## 3. The document

```ts
export interface ElementStore {
  readonly byId: Readonly<Record<ElementId, CanvasElement>>;
  /** Root-level ids, bottom to top. Members of a group live on its `childIds`. */
  readonly order: readonly ElementId[];
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly viewport: Viewport;
  readonly elements: ElementStore;
  readonly metadata: ProjectMetadata; // createdAt / updatedAt, ISO 8601
}
```

### Why `{ byId, order }` rather than `CanvasElement[]`

A flat array is simpler and would be the right answer for a list. It is the
wrong answer for a document that is indexed by id on every frame.

**O(1) lookup.** Selection is a `Set<ElementId>` (`docs/state-management.md`).
Resolving it against an array is O(n) per id, so painting the selection overlay
for k selected elements out of n is O(k·n). Against a map it is O(k). The same
applies to `useElement(id)` in the layers panel, to `elementsByIds`, and to the
selection-pruning pass that runs after every undo.

**Reordering does not touch elements.** `bringForward` on an array of elements
splices element objects; on `{ byId, order }` it rewrites an array of strings and
leaves every element object's identity intact. That matters because element
identity _is_ the mechanism history uses:

```ts
// store/elementsSlice.ts
function withOrder(document: ElementStore, order: readonly ElementId[]): ElementStore {
  return order === document.order ? document : { byId: document.byId, order };
}
```

The new `ElementStore` shares the _same_ `byId` object. A reorder snapshot costs
one array of strings and nothing else. `store.test.ts` asserts this directly:
"reorders layers without producing new element objects".

**Patching one element does not touch the others.** `patchDocument` builds a new
`byId` only if something actually changed, and copies pointers:

```ts
byId ??= { ...document.byId };
byId[id] = next;
```

Every untouched element is `===` its previous object. That is what makes
snapshot-based undo affordable (`docs/history.md`).

**The cost, stated.** "Give me elements in paint order" is a depth-first walk
from `order` through each group's `childIds` (`features/elements/tree.ts`), which
is one O(n) pass. It runs once per frame in the renderer and is memoized on the
`ElementStore`'s identity (`components/canvas/useRenderer.ts`,
`createOrderCache`), so panning and zooming - which do not change the document -
reuse the array rather than rebuilding it. During a drag the document genuinely
changes every frame and the cache misses every frame, which is correct: there is
nothing to reuse.

**`order` names roots only, and that is a narrowing worth stating loudly.** It
used to mean "every element in the document" and now means "every element with
no parent". The type is identical, so nothing failed to compile, and the tests
build `ElementStore` literals directly rather than routing through the
selector - so nothing failed there either. Twelve production call sites of
`elementsInOrder` silently stopped seeing group members and every one was found
by review rather than by a test. `docs/problems-log.md` entry 006 is the whole
story; the short version is that **broadening a type is caught by the compiler
and narrowing the meaning of a value inside an unchanged type is caught by
nothing.** `features/elements/tree.ts` holds the walks that answer the question
correctly, and `features/export/scope.ts` holds the three different right
answers for export.

The second cost is that `{ byId, order }` can represent invalid states: an id in
`order` with no entry in `byId`, an entry in `byId` missing from `order`, a
duplicate in `order`. The in-memory code tolerates the first (both
`elementsInOrder` and `serializeProject` skip missing entries) and the
serialization boundary eliminates all three - see below.

### Why there is deliberately no `zIndex`

The project spec lists a `zIndex` field. It is not implemented, on purpose.

Depth is the element's index in `ElementStore.order`. An ordered array **cannot
represent an invalid depth state**. A per-element `zIndex` number can, in three
ways:

- **Duplicates.** Two elements at `zIndex: 3`. Paint order becomes whatever the
  sort happens to be - unstable, and different between a `sort()` and a
  `toSorted()`.
- **Gaps.** After deleting the element at 4, the sequence is 1, 2, 3, 5. Nothing
  is broken yet, but "send backward" now has to answer "backward past what?"
  with arithmetic rather than an index decrement.
- **Renumbering.** Inserting between 2 and 3 either needs fractional indices
  (which drift toward float precision loss under repeated insertion) or a
  renumbering pass that rewrites _every_ element - which, in this codebase, would
  mint n new element objects and destroy the structural sharing that history
  depends on.

With an array: `bringForward` is a swap, `sendToBack` is an unshift, and depth is
never wrong because it is not stored. The whole z-order feature is
`features/elements/zorder.ts`, operating on `readonly ElementId[]`.

The trade-off is that z-order is a property of the document, not of the element,
so an element cannot be moved between documents with its depth intact. Nothing in
the product needs that.

### The serialized shape is deliberately different

```ts
export interface SerializedGroupElement extends Omit<GroupElement, 'childIds'> {
  readonly children: readonly SerializedElement[];
}

export type SerializedElement =
  | Exclude<CanvasElement, GroupElement>
  | SerializedGroupElement;

export interface SerializedProject {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly viewport: Viewport;
  readonly elements: readonly SerializedElement[]; // a nested forest, in paint order
  readonly metadata: ProjectMetadata;
  /** Image blobs as data URIs, keyed by `ImageElement.imageKey`. */
  readonly images: Readonly<Record<string, string>>;
}
```

Two differences from the in-memory `Project`, each for its own reason.

**`elements` is a nested forest in paint order - and this reverses an argument
this document used to make.** Before groups, it was a flat array, justified here
on the grounds that an array is self-describing and cannot disagree with itself
the way `{ byId, order }` can, in the three ways listed above.

That argument now points the other way, and the reversal is the interesting
part. A flat array *carrying membership* can disagree with itself: an id listed
inside a group's `childIds` and also at the root describes two different trees,
and the loader would have to pick one. Nesting cannot express that state at all,
because an element is written exactly where it belongs, once. Same principle -
prefer the encoding that cannot represent an invalid state - opposite
conclusion, because the data changed. It also mirrors SVG's `<g>`, which is what
the export already wanted.

Nesting removes two whole classes of corruption from the file by construction:
dangling child references and cycles. It adds exactly one, which is depth - a
hostile file can nest far enough to overflow the stack on any recursive walk.
`MAX_GROUP_DEPTH` is 64 and is the only thing standing between untrusted input
and a crash; see "Validation" below.

`serializeProject`/`fromSerialized` in `features/project/serialize.ts` are still
the only two functions that cross the boundary. `fromSerialized` collects each
group's children *first* and uses the result as its `childIds`, so the store's
parentage and the file's nesting are the same fact rather than two facts that
have to be kept in agreement.

**`schemaVersion` lives on the serialized form only.** An in-memory `Project` is
by construction current-schema; carrying a version field there would be a value
that is always the same constant and one more thing for a migration to forget to
update. See `docs/export.md` for the migration chain.

`images` is populated only when exporting. The IndexedDB record is written with
`images: {}` because the blobs live in their own store
(`services/projectRepository.ts`, `writeProject`). Same schema, two population
strategies.

### Validation is per-element, and drops rather than aborts

`features/project/validate.ts` treats every incoming document as hostile. Two
rules:

**Drop, don't abort.** One malformed element is dropped with a warning; the rest
of the document loads. Rejecting the file would cost the user their project
because of one broken shape.

**Clamp, don't reject.** `opacity: 4`, a negative width, `x: NaN` are all
recoverable and the intent is obvious. Only fields carrying _identity_ -
`id`, `type`, `imageKey`, and a freehand's `points` - cause a drop, because there
is nothing sensible to invent for them.

```ts
// A horizontal line's bounding box legitimately has zero height, so this
// clamps at 0 rather than at MIN_ELEMENT_SIZE.
width: Math.max(0, asNumber(rec.width, 0)),
opacity: clamp(asNumber(rec.opacity, 1), 0, 1),
```

Duplicate ids are dropped too, because two elements sharing an id would make
selection and z-order ambiguous. Under nesting that single check does more work
than it looks: one `seen` set, marked *before* descending into a group's
children, catches a duplicate at the root, one id claimed by two different
parents, and a group that contains itself - all three are "this id is already
spoken for". Dropping a group drops everything inside it, and the warning says
so, because otherwise it undercounts what the user actually lost.

**Depth is capped at `MAX_GROUP_DEPTH` (64), on the load and repository
paths.** Nesting is the one corruption class the nested format *adds*, and a
recursive walk over an attacker-supplied document is a stack overflow waiting
to happen. Anything deeper is dropped and reported through the same warnings
channel, and the cap is enforced at both places a file becomes a document -
`validate.ts` on the load path, and `services/projectRepository.ts`'s own raw
walk, which summarizes records validation has not touched yet. 64 is far
beyond any structure a person builds by hand and far below the engine's frame
budget for a recursive walk.

Clipboard paste is a third untrusted-input path and does not enforce this cap:
`validateElement.ts` admits a group's `childIds` verbatim, one element at a
time, with no notion of its own depth (see `docs/export.md` §2, "Validation").
A known gap, not a behaviour change made here.

A group with a missing or non-array `children` is a drop rather than a clamp:
membership is the group's whole identity, and there is nothing sensible to
invent for it. An explicit `[]` is different - that is a well-formed statement
of "no members", and the store's own empty-group rule decides what to do with
it.

Colours are matched against a permissive pattern that admits hex, functional
notation, and bare identifiers, and **rejects `url(...)`** - an SVG paint-server
reference can point off-origin. Data URIs are checked against
`ACCEPTED_IMAGE_TYPES` before they can reach an `<image href>` or an
`Image.src`. Those two are security boundaries, not tidiness: a project file is
attacker-supplyable.

Hand-written guards rather than zod/valibot. The schema is one union of eight
variants, the interesting part is the _policy_ (what clamps, what drops, what is
rejected outright) rather than the shape, and a runtime schema library would add
bundle weight to re-express something the compiler already describes.

---

## 4. Geometry primitives

`src/types/geometry.ts` defines the vocabulary the rest of the model is written
in. Two things there are worth naming here; the full treatment is in
`docs/coordinate-system.md`.

`ScreenPoint`, `WorldPoint`, `WorldVector`, `WorldRect`, `ScreenRect` are
**branded** - structurally identical at runtime, distinct to the compiler.
`Vec2` is the unbranded escape hatch, used by `LineElement.start`,
`FreehandElement.points`, and the pure maths in `utils/geometry.ts`. Normalized
endpoints are genuinely space-less (they are fractions), so branding them would
be noise.

`Matrix2D` is a flat readonly tuple `[a, b, c, d, e, f]` in the order the Canvas
2D API takes them, so a matrix can be handed straight to
`ctx.transform(...)` with no shuffling - which means the transform the
hit-tester inverts is bit-for-bit the transform the renderer painted with.

---

## 5. Adding a ninth element type

The full checklist, in order, so the size of the change is concrete:

1. Add the interface to `src/types/element.ts` and to the `CanvasElement` union,
   and add its `type` string to `ElementType`.
2. `npm run typecheck` - every exhaustive `switch` now fails to compile. Fix each.
3. Add a drawer in `engine/drawers/` and register it in `drawers/index.ts`.
4. Add its local-space test to `hitTest.containsLocalPoint`.
5. Add its SVG mapping in `export/svg.ts`.
6. Add its validation branch in `project/validateElement.ts` (the per-element
   half; `project/validate.ts` owns the shape of the forest).
7. Add a factory in `elements/factory.ts` and a label to `ELEMENT_TYPE_LABEL`.
8. If it can be drawn with a tool: add the tool id, a `DRAW_LABELS` entry in
   `interaction/machine.ts`, and a `buildDraft` branch in `executeIntents.ts`.

Steps 3–6 are found _by the compiler_, not by grep. That is the entire argument
for the union.
