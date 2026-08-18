# Coordinate system

Two spaces, one transform, and the rules that keep them from mixing. This is the
single largest source of bugs in a canvas editor, so it gets the longest
document.

Source of truth: `src/utils/coords.ts`, `src/types/geometry.ts`,
`src/features/canvas/engine/matrix.ts`, `src/features/canvas/engine/hitTest.ts`,
`src/features/canvas/engine/Renderer.ts`.

---

## 1. The two spaces

**Screen space** - CSS pixels, origin at the canvas element's top-left corner,
y growing downward. This is where pointer events live, where handles are sized,
and where the selection overlay is drawn.

**World space** - document units, origin arbitrary, unbounded in all four
directions. This is where `element.x`, `element.y`, `element.width`,
`element.height` live. Nothing clamps `panX`/`panY` and there is no document
boundary; that is the whole meaning of "infinite canvas".

```
    pointer events, handle sizes,             element.x / element.y,
    selection chrome, canvas size              hit tests, culling, bounds
              │                                          ▲
              │  screenToWorld                           │  worldToScreen
              ▼                                          │
      ┌───────────────────────────────────────────────────┐
      │        Viewport { panX, panY, zoom }               │
      │        screen = world · zoom + pan                 │
      └───────────────────────────────────────────────────┘
```

The viewport is three numbers:

```ts
export interface Viewport {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}
```

`zoom` is a scale factor (1 = 100%). `panX`/`panY` are the **screen** position of
the world origin - not a world offset. That convention is why `panBy` is a plain
addition of a screen delta and needs no division:

```ts
// store/viewportSlice.ts
panBy: (dxScreen, dyScreen) => {
  const { viewport } = get();
  set({ viewport: { ...viewport, panX: viewport.panX + dxScreen, panY: viewport.panY + dyScreen } });
},
```

Storing pan in world units instead would make every pan a divide, and would make
the transform `screen = (world + pan) · zoom` - which is a different transform
that composes differently, and mixing the two conventions in one codebase is a
classic way to get drift that only shows up away from 100% zoom.

---

## 2. Branded types

`ScreenPoint` and `WorldPoint` are structurally identical: both are
`{ x: number, y: number }`. Nothing but discipline stops you from subtracting one
from the other, and the result compiles, runs, and is wrong.

```ts
// src/types/geometry.ts
declare const spaceBrand: unique symbol;

interface Point {
  readonly x: number;
  readonly y: number;
}

export type ScreenPoint = Point & { readonly [spaceBrand]: 'screen' };
export type WorldPoint = Point & { readonly [spaceBrand]: 'world' };
export type WorldVector = Point & { readonly [spaceBrand]: 'world-delta' };
```

The brand is a phantom property keyed by a `unique symbol` that is `declare`d and
never defined. It exists only in the type system - at runtime a `WorldPoint` is a
plain object with two number fields, and there is zero cost.

`WorldRect` and `ScreenRect` are branded the same way.

### The class of bug this prevents

Three distinct mistakes, all of which type-check without brands:

**Passing a screen point where a world point is expected.**

```ts
const screen = eventToScreenPoint(event, canvasBounds);
hitTestPoint(screen, elements, viewport);
//           ^^^^^^ Argument of type 'ScreenPoint' is not assignable to
//                  parameter of type 'WorldPoint'.
```

Without the brand this compiles and hit-testing silently works only at
`zoom === 1`, `pan === (0,0)` - which is exactly the state you develop in.

**Confusing a position with a displacement.** This is the subtler one, and it is
why `WorldVector` is a third brand rather than an alias of `WorldPoint`. A
position converts with pan; a displacement must not:

```ts
export function screenToWorld(point: ScreenPoint, viewport: Viewport): WorldPoint {
  return worldPoint(
    (point.x - viewport.panX) / viewport.zoom,
    (point.y - viewport.panY) / viewport.zoom
  );
}

export function screenDeltaToWorld(dx: number, dy: number, viewport: Viewport): WorldVector {
  return worldVector(dx / viewport.zoom, dy / viewport.zoom); // no pan term
}
```

Applying the pan offset to a drag delta produces the signature symptom:
**dragging works perfectly at 100% zoom and drifts everywhere else** - because at
`zoom === 1` with `pan === 0` the two functions agree. It is nearly invisible in
development and immediately obvious to a user. `coords.test.ts` pins it:

```ts
it('scales a delta without applying pan', () => {
  // The bug this guards: dragging works at 100% zoom and drifts at any other.
  expect(screenDeltaToWorld(50, 25, viewport)).toEqual({ x: 20, y: 10 });
});
```

**Mixing rectangles.** `WorldRect` and `ScreenRect` keep `visibleWorldRect` (world)
from being handed to a function expecting the canvas's own pixel rect.

### The one rule that makes brands work

The brands are applied and stripped in `utils/coords.ts` **and nowhere else**.
Everything else in the codebase either receives an already-branded value or calls
a `coords.ts` constructor. `worldPoint`, `screenPoint`, `worldVector`,
`worldRect`, `screenRect` are the only casts; `toVec2` is the only strip.

That is a convention, not a compiler-enforced constraint - anyone can write
`{ x, y } as WorldPoint` in any file. It holds because the constructors are
shorter than the cast and because there is exactly one place to look when a
coordinate bug appears. Two known-and-accepted exceptions exist, both inside the
selection/geometry layer:

- `features/selection/handles.ts` casts one arithmetic result to `ScreenPoint`
  when offsetting the rotation handle along a unit vector.
- `features/export/png.test.ts` and similar tests construct branded values
  directly, which is fine: a test asserting on the maths does not need the
  ceremony.

The deeper reason the discipline is affordable is that `coords.ts` is the only
file that knows the transform at all. Changing the transform - adding a rotated
canvas, moving the origin convention, folding in device pixel ratio - is a
single-file change.

---

## 3. The forward and inverse transforms

```ts
// world → screen
screenX = worldX * zoom + panX;
screenY = worldY * zoom + panY;

// screen → world  (the algebraic inverse)
worldX = (screenX - panX) / zoom;
worldY = (screenY - panY) / zoom;
```

Both directions exist because both are needed constantly. World→screen for the
overlay pass and the handle geometry; screen→world for every pointer event.

`coords.test.ts` asserts the round trip is lossless to 6 decimal places over
inputs spanning ±10⁶ at `zoom = 2.5`. That test is cheap and it is the one that
would catch a sign error or a transposed pan term.

Two derived conversions matter enough to be named:

```ts
/** A length in screen pixels expressed in world units - for zoom-invariant tolerances. */
export function screenLengthToWorld(lengthPx: number, viewport: Viewport): number {
  return lengthPx / viewport.zoom;
}
```

This is what makes a 1px hairline still clickable at 5% zoom without the click
target becoming an absurd slab at 3200%. `hitTestPoint` calls it once per pick
with `STROKE_HIT_TOLERANCE_PX = 6`.

```ts
export function eventToScreenPoint(
  event: { readonly clientX: number; readonly clientY: number },
  canvasBounds: DOMRect
): ScreenPoint {
  return screenPoint(event.clientX - canvasBounds.left, event.clientY - canvasBounds.top);
}
```

`clientX/Y` are viewport-relative. The canvas is inset by the toolbar and the
panel rail and the page may be scrolled, so the element's bounding rect has to be
subtracted. **Limitation:** subtracting only the origin is correct as long as the
canvas is not CSS-scaled. If the canvas or an ancestor ever carried a
`transform: scale(...)`, the pointer mapping would need the rect's _size_ as well
(`(clientX - left) * canvas.width / rect.width`). Nothing scales it today, and
this is called out rather than assumed.

---

## 4. Zoom about the cursor - the algebra

Naïve zoom multiplies `zoom` and leaves `pan` alone. That scales about the world
origin, which sends the content the user is looking at flying off screen. Every
editor instead holds the point under the cursor fixed.

State the requirement as an invariant. Let the cursor be at screen position
`a_s`, the viewport before the change be `(p, z)` and after be `(p′, z′)`. Let
`a_w` be the world point currently under the cursor.

**Step 1 - find the anchor.** Invert the forward transform at the current zoom:

```
a_w = (a_s − p) / z
```

**Step 2 - choose the new zoom**, clamped to the legal range:

```
z′ = clamp(z · factor, MIN_ZOOM, MAX_ZOOM)
```

**Step 3 - solve for the pan that keeps the anchor under the cursor.** The
invariant we want is that the same world point still maps to the same screen
point after the change:

```
worldToScreen(a_w, (p′, z′)) = a_s
              a_w · z′ + p′  = a_s
                          p′ = a_s − a_w · z′
```

That is the whole derivation. Two lines of code:

```ts
export function zoomAroundPoint(
  viewport: Viewport,
  anchorScreen: ScreenPoint,
  nextZoomRaw: number
): Viewport {
  const nextZoom = clampZoom(nextZoomRaw);
  const anchorWorld = screenToWorld(anchorScreen, viewport);
  return {
    zoom: nextZoom,
    panX: anchorScreen.x - anchorWorld.x * nextZoom,
    panY: anchorScreen.y - anchorWorld.y * nextZoom,
  };
}
```

### Two details that are easy to get wrong

**The clamp happens before the solve, not after.** If you compute `p′` from the
requested zoom and _then_ clamp `z′`, the anchor is solved against a zoom that
was never applied and the content lurches at the zoom limits - a small, weird
jump that users notice and cannot describe. Because `clampZoom` runs first here,
the invariant holds even when the requested zoom is refused outright:

```ts
it('holds the anchor fixed even when the requested zoom is clamped', () => {
  const next = zoomAroundPoint(viewport, cursor, MAX_ZOOM * 100);
  expect(next.zoom).toBe(MAX_ZOOM);
  // anchor still maps to the same world point
});
```

**Substituting the anchor is not optional.** A shortcut that adjusts pan by
`(1 − factor) · cursor` looks equivalent and is only correct when `pan` is
already zero.

### Everything else is this, with a different anchor

| Gesture                          | Anchor          | Zoom                                |
| -------------------------------- | --------------- | ----------------------------------- |
| Ctrl/Cmd + wheel, trackpad pinch | cursor position | `zoom · exp(−deltaY · sensitivity)` |
| `+` / `−` buttons                | viewport centre | next entry in `ZOOM_STEPS`          |
| Zoom to 100% (`mod+0`)           | viewport centre | `1`                                 |

`zoomToStep` falls back to the viewport centre when no anchor is given, rather
than to `(0, 0)`:

```ts
const anchor = anchorScreen ?? screenPoint(viewportSize.width / 2, viewportSize.height / 2);
```

Anchoring at the origin would drag the drawing toward the top-left corner every
time the `+` button is pressed.

The wheel factor is exponential:

```ts
export function wheelDeltaToZoomFactor(deltaY: number, sensitivity: number): number {
  return Math.exp(-deltaY * sensitivity);
}
```

Exponential because zoom is multiplicative. A linear `zoom -= delta · k` gives
notches that feel enormous at 10% and imperceptible at 800%; `exp` makes each
notch a constant _ratio_, so the gesture feels the same at every scale. It is
also symmetric: scrolling up n notches and back down n notches returns exactly to
the starting zoom, because `exp(x) · exp(−x) = 1`.

A trackpad pinch arrives as a wheel event with `ctrlKey` set - the browser
synthesises it and there is no gesture event to read - so pinch and Ctrl+wheel
land in the same branch of `usePointerInteraction`'s wheel handler. There is no
two-finger midpoint calculation; the synthesised event's coordinates are the
anchor.

### Zoom to fit

`viewportToFit` solves the same invariant, but with both halves known in
advance: the anchor's world position is the content's centre and its screen
position is the viewport's centre.

```ts
const usableWidth = viewportWidthPx * (1 - padding * 2);
const usableHeight = viewportHeightPx * (1 - padding * 2);
const zoom = clampZoom(Math.min(usableWidth / content.width, usableHeight / content.height));

return {
  zoom,
  panX: viewportWidthPx / 2 - contentCenterX * zoom,
  panY: viewportHeightPx / 2 - contentCenterY * zoom,
};
```

`Math.min` of the two ratios is what makes it _fit_ rather than _fill_ - the
tighter axis wins. `padding` is a fraction of the viewport (`ZOOM_TO_FIT_PADDING
= 0.1`), doubled because it applies to both sides.

Empty content has no meaningful frame, so a zero-area rect returns the default
view (origin centred at 100%) rather than dividing by zero and producing
`Infinity` zoom.

Note that `viewportToFit` re-derives `p = s − w·z` inline rather than calling
`zoomAroundPoint`. It is the same identity, not a shared call.

### Zoom limits

```ts
export const MIN_ZOOM = 0.02; //   2%
export const MAX_ZOOM = 64; // 6400%
```

Below ~2% a design is a smear of sub-pixels and the dot grid is denser than the
pixel grid (the grid stops drawing below `GRID_MIN_VISIBLE_ZOOM = 0.35` for that
reason). Above ~64× the float error in the transform starts to be visible as
jitter while panning: `panX` grows with `world · zoom`, so at large zoom the pan
term dominates the mantissa and small world deltas fall off the end of the
double.

Pan itself is **not** clamped. There is no document boundary, so there is nothing
to clamp against. The practical limit is the same float precision argument: pan
far enough from the origin at high zoom and positions start to quantize. Nothing
in the app defends against that, and it is reachable only by deliberately
scrolling for a very long time.

---

## 5. Device pixel ratio is kept out of the viewport transform

This is a deliberate architectural line and it is worth stating precisely,
because folding DPR into the viewport is the "obvious" simplification and it
produces a bug that only reproduces on half the machines that see it.

The backing store is sized in device pixels and the context is scaled to
compensate:

```ts
// engine/Renderer.ts
resize(cssWidth: number, cssHeight: number, dpr = 1): void {
  const pixelWidth  = Math.max(1, Math.round(cssWidth  * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (this.canvas.width  !== pixelWidth)  this.canvas.width  = pixelWidth;
  if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
  this.markDirty();
}
```

DPR then appears in exactly two places, both inside `Renderer`:

```ts
// Pass 1 (clear) and pass 3 (overlay): CSS pixels, DPR only.
ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

// Pass 2 (world): DPR composed with the viewport.
private applyWorldTransform(viewport: Viewport): void {
  const scale = viewport.zoom * this.dpr;
  this.ctx.setTransform(scale, 0, 0, scale, viewport.panX * this.dpr, viewport.panY * this.dpr);
}
```

`utils/coords.ts` contains no `dpr` at all. Consequences:

- **All drawing code works in CSS pixels.** A drawer never thinks about DPR; an
  8px handle is 8 CSS pixels whether the display is 1× or 3×.
- **Hit-testing never sees DPR.** `screenToWorld` operates on CSS pixels from
  `eventToScreenPoint`, which operates on `clientX` - also CSS pixels. If DPR
  were part of the viewport transform, every pointer coordinate would need
  dividing by it, and forgetting that in one place is a factor-of-2 offset that
  _works correctly on a 1× monitor_. It reproduces only on retina, which is a
  miserable bug to receive as a report.
- **Export sets `dpr = 1` and puts its scale factor in `zoom` instead**
  (`features/export/png.ts`, `paintWithRenderer`). If DPR were part of the
  viewport, a 3× export on a retina machine would come out 6×.

Note `setTransform` **replaces** the current transform rather than composing with
it, which is why pass 2 multiplies DPR into the same call instead of applying it
separately - applying them as two `setTransform` calls would drop the DPR scale
entirely.

DPR is also not constant. Dragging a window from a retina laptop to a 1×
external monitor changes `devicePixelRatio` with no `resize` event.
`useCanvasSize` handles this by matching on the _current_ ratio
(`(resolution: 2dppx)`) and re-subscribing when that query stops matching - the
effect re-runs on every DPR change and builds a query for the new ratio. A single
fixed query would only ever fire once.

---

## 6. Culling and the visible world rect

Frame cost has to track what is on screen, not what exists. That needs a
world-space description of the visible region:

```ts
export function visibleWorldRect(
  viewportWidthPx: number,
  viewportHeightPx: number,
  viewport: Viewport
): WorldRect {
  const topLeft = screenToWorld(screenPoint(0, 0), viewport);
  return worldRect(
    topLeft.x,
    topLeft.y,
    viewportWidthPx / viewport.zoom,
    viewportHeightPx / viewport.zoom
  );
}
```

The top-left corner converts as a _position_ (pan applies); the extents convert
as _lengths_ (pan does not). Getting that wrong gives a rect that is correct at
`pan === 0` and wrong otherwise - the same failure signature as the delta bug in
§2, from the same root cause.

The renderer culls against it once per element per frame:

```ts
const visible = visibleWorldRect(this.cssWidth, this.cssHeight, scene.viewport);
for (const element of scene.elements) {
  if (!element.visible) continue;
  if (!rectsIntersect(visible, worldBounds(element))) continue;
  this.drawOne(element, deps);
}
```

Two subtleties:

**`worldBounds` is rotation-aware.** It calls `rotatedBounds`, not the element's
raw `{x, y, width, height}`. A 200×20 bar rotated 90° occupies a 20×200 region of
the world; culling on the unrotated rect would make it vanish while it is plainly
on screen. The closed form avoids rotating four corners:

```ts
// utils/geometry.ts
const cos = Math.abs(Math.cos(rotation));
const sin = Math.abs(Math.sin(rotation));
const width = normalized.width * cos + normalized.height * sin;
const height = normalized.width * sin + normalized.height * cos;
```

A corner sits at offset `(±w/2, ±h/2)` from the centre, so after rotation its
x-offset is `±(w/2)·cos θ ∓ (h/2)·sin θ`. The extreme over the four sign
combinations is reached when both terms share a sign - which is exactly
`(w/2)·|cos θ| + (h/2)·|sin θ|`. Two trig calls instead of four rotations and
eight comparisons, once per element per frame.

`rotatedBounds` treats `|rotation| < 1e-9` as unrotated. An exact `=== 0` test
misses values like `1e-17` that arrive from drags and JSON round trips, which
would push every element onto the slower path _and_ grow its AABB by a hair,
making culling and selection boxes jitter.

**`rectsIntersect` counts touching as intersecting**, expressed as the negation
of the four separating cases:

```ts
return !(
  a.x + a.width < b.x ||
  b.x + b.width < a.x ||
  a.y + a.height < b.y ||
  b.y + b.height < a.y
);
```

An element flush against the viewport edge is still partly on screen, so the
inclusive convention is the one culling wants.

**Limitations.** Culling is a linear scan: the _test_ is cheap but the loop is
still O(n) in document size even when nothing is visible. At the scale where that
matters the answer is a spatial index (grid or quadtree), which is deliberately
not built - see `docs/performance.md` for measured numbers. The cull also uses
the AABB, so a large rotated element whose AABB overlaps the viewport but whose
actual shape does not is drawn and clipped by the canvas. That is the correct
trade: an exact test costs more than the draw it would save.

---

## 7. Element matrices, and hit-testing by inverting them

### Building the matrix

```ts
export type Matrix2D = readonly [a, b, c, d, e, f];

//   | a  c  e |        x' = a*x + c*y + e
//   | b  d  f |        y' = b*x + d*y + f
//   | 0  0  1 |
```

Six values, in the order `ctx.transform(a, b, c, d, e, f)` takes them. The bottom
row of an affine matrix is always `[0 0 1]`, so storing it would be six wasted
multiplies per compose. Matching the canvas order means a matrix goes straight to
the context with no shuffling - which is the property that makes the transform
the hit-tester inverts bit-for-bit identical to the one the renderer painted
with.

An element's local→world transform:

```ts
export function elementMatrix(element: CanvasElement): Matrix2D {
  const { x, y, width, height, rotation } = element;
  if (rotation === 0) return fromTranslation(x, y);

  return multiply(
    multiply(fromTranslation(x + width / 2, y + height / 2), fromRotation(rotation)),
    fromTranslation(-width / 2, -height / 2)
  );
}
```

Local space has its origin at the element's **top-left**, unrotated, so every
drawer paints at `(0,0)–(width,height)` and never thinks about the angle. The
composition, read right-to-left (the rightmost factor acts on the point first):

```
M = T(cx, cy) · R(θ) · T(−w/2, −h/2)          where cx = x + w/2, cy = y + h/2
```

1. `T(−w/2, −h/2)` moves the local origin to the element's centre - necessary
   because a rotation matrix always pivots about _its own_ origin, and rotation
   here is defined about the element's centre.
2. `R(θ)` rotates.
3. `T(cx, cy)` moves the centre out to its world position.

Note the first factor is `T(−w/2, −h/2)` and **not** `T(−cx, −cy)`. The local
origin is already at the top-left rather than at the world origin, so the offset
needed is only the half-extent. Expanding `T(cx,cy)·R·T(−cx,−cy)·T(x,y)` gives
the same matrix - the code is that product already simplified, saving one
multiply per rotated element per frame.

`rotation === 0` short-circuits to a plain translation, skipping two matrix
multiplies and two trig calls. That is the overwhelmingly common case.

`multiply(a, b)` means "apply **b** first, then a" - the mathematical convention
and the one `ctx.transform` follows, so `compose(...)` reads in the same
direction as the equivalent sequence of canvas calls.

### Inverting instead of transforming the shape

The naive approach to "is this point inside this rotated ellipse?" is to
transform the _shape_ into world space and test a rotated figure. That needs a
bespoke rotated test per element type - a rotated-rectangle test, a rotated-ellipse
test, a rotated-capsule test for lines - each with its own edge cases.

The trick is to move the **point** instead:

```ts
const inverse = inverseElementMatrix(element);
if (inverse === null) continue;
const local = applyToPoint(inverse, worldPoint);
if (containsLocalPoint(element, local, tolerance)) return element;
```

In local space every element is axis-aligned at the origin, so each test is
trivial:

| Type               | Local test                                                   |
| ------------------ | ------------------------------------------------------------ |
| rectangle (filled) | `rectContainsPoint(expandRect(box, tol), local)`             |
| rectangle (hollow) | inside the outer band and not the inner band                 |
| ellipse            | `((x−cx)/rx)² + ((y−cy)/ry)² ≤ 1`                            |
| line / arrow       | `distancePointToSegment(local, start·size, end·size) ≤ band` |
| text / image       | rectangle containment                                        |
| freehand           | AABB early-out, then per-segment distance                    |

**Rotation needs no per-type special case at all.** One `invert` per element
replaces seven rotated shape tests. That is the argument for a hand-rolled
engine in one sentence.

The inverse is the adjugate over the determinant for the 2×2 linear part, with
the translation column expanded inline:

```ts
export function invert(m: Matrix2D): Matrix2D | null {
  const [a, b, c, d, e, f] = m;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < SINGULAR_EPSILON) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
```

It returns `null` rather than throwing, because the caller - a hit test during a
`pointermove` - has a sensible answer available ("nothing was hit") and an
exception in a pointermove handler takes the interaction down.

`SINGULAR_EPSILON = 1e-12` rather than `=== 0`: a transform scaled to 1e-9 is
arithmetically invertible, but its inverse has entries around 1e9 and running a
pointer coordinate through it produces garbage rather than an error. Refusing
early turns a silent wrong answer into a `null` the caller must handle.

An element matrix today is translate ∘ rotate, whose determinant is exactly 1, so
that branch is unreachable. It is kept because `invert` is honest about
singularity and the day a scale term joins the composition is the day it stops
being unreachable.

### Tolerance in local space

Because the element matrix is translate ∘ rotate with **no scale**, a distance in
local units equals the same distance in world units. That is why the tolerance is
converted once, from screen pixels to world units, and then used directly against
local coordinates with no further conversion:

```ts
const tolerance = screenLengthToWorld(STROKE_HIT_TOLERANCE_PX, viewport);
```

If a scale term were ever added to `elementMatrix`, this would silently become
wrong - the tolerance would be scaled along with everything else. It is called out
in a comment in `hitTest.ts` for that reason.

Stroke width contributes on top: half the stroke straddles the path on each side,
so `strokeBand(w) = w / 2` is added to the tolerance for stroked shapes.

### Picking order

```ts
for (let i = elements.length - 1; i >= 0; i -= 1) { … }
```

Elements arrive in paint order (bottom→top) and are walked in reverse, so the
first hit is the topmost - the one the user can see and therefore the one they
meant. `isPickable` skips hidden and locked elements inside the loop rather than
in the caller, so every picking path agrees on what is clickable.

Marquee selection is a different question and gets a different answer:
`hitTestRect` tests world-AABB intersection, not exact shape overlap. One
comparison per axis instead of a polygon clip, and it matches expectation -
dragging a box across a rotated shape's corner selects it. Precision there would
be pedantry that costs frames during the drag.

**Known approximation:** freehand strokes are tested against their raw sample
points, while the drawer paints a quadratic-through-midpoints smoothing of them.
The smoothed curve deviates by at most half a sample spacing, comfortably inside
the tolerance band, and testing a Bézier per segment would cost a root solve per
segment per pointermove for no perceptible gain.

---

## 8. The overlay: screen space on purpose

Selection outlines, resize handles, the rotation handle, and the marquee are
drawn in a **third pass with the viewport transform reset**:

```ts
// Pass 3 - screen space. Reset so the overlay's pixel sizes are literal.
ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
if (chrome.overlay) drawOverlay(ctx, scene, theme);
```

Every coordinate inside `engine/overlay.ts` is a CSS pixel. If chrome were drawn
under the world transform, a `1.5px` selection outline would render at `0.05px`
at 3% zoom and `48px` at 3200%, and an 8px handle would be a sub-pixel speck or
cover the whole shape.

`features/selection/handles.ts` computes the positions by going _through_ world
space and out again:

```ts
const anchorToScreen = (fx: number, fy: number): ScreenPoint => {
  const unrotated = { x: rect.x + fx * rect.width, y: rect.y + fy * rect.height };
  const rotated = rotatePoint(unrotated, pivot, rotation);
  return worldToScreen(worldPoint(rotated.x, rotated.y), viewport);
};
```

So the handle **positions** follow the selection's rotation and zoom, while their
**sizes** do not. Dragging the `e` handle of a tilted rectangle widens it along
its own axis, because the position came from the rotated world box.

The rotation handle floats a fixed screen distance beyond the top edge, along the
selection's own "up". World up is `(0, −1)`; rotating it by θ gives
`(sin θ, −cos θ)`. The viewport transform is a uniform positive scale plus a
translation, so it **preserves direction** - the same unit vector is valid in
screen space and the offset can be applied directly in pixels:

```ts
const upX = Math.sin(rotation);
const upY = -Math.cos(rotation);
center: { x: north.x + upX * ROTATION_HANDLE_OFFSET_PX,
          y: north.y + upY * ROTATION_HANDLE_OFFSET_PX }
```

That is what keeps the handle exactly 22px from the edge at every zoom instead of
drifting away as you zoom in. It relies on the transform having no rotation or
non-uniform scale; if the viewport ever gained either, this shortcut breaks and
the offset would have to be transformed properly.

Handle hit-testing is also screen space, with a grab target larger than the
painted square:

```ts
const reach = HANDLE_SIZE_PX / 2 + HANDLE_HIT_PADDING_PX; // 4 + 4 = 8px half-extent
```

An 8px square is a hard target for a trackpad and impossible for a finger. The
test is a square rather than a circle: it matches the painted shape and is four
comparisons instead of a hypotenuse. `rotate` wins over every other handle
because it sits outside the box and nothing else can legitimately claim its
pixels.

---

## 9. Resize in the element's own frame

The same "transform the input, not the shape" idea appears a third time, in
`features/elements/operations.ts`.

A rotated element resized in world space produces a sheared, wandering box: the
handle the user grabbed is not on a world axis, so "drag right" is not "make
wider". The fix:

```
c   = centre of the original box (world)
θ   = the box's rotation
q   = R(−θ) · (worldPoint − c)          the pointer, in the box's own frame
```

In that frame the box is axis-aligned and spans `[−w/2, w/2] × [−h/2, h/2]`, so
the handle maths is the trivial unrotated case. Once the new local extents are
known, the box's centre has moved by `m = ((l+r)/2, (t+b)/2)` **in local
coordinates**, so the new world centre is:

```
c′ = c + R(θ) · m
```

which is what pins the corner opposite the grabbed handle in world space. `θ = 0`
collapses all of it to plain addition, so there is one code path rather than two.

Two related conventions elsewhere in the interaction layer:

**Transform intents carry the total delta from the gesture origin, never an
increment.** The adapter snapshots the affected elements when it sees
`beginTransaction` and re-applies each intent against that snapshot, so a
200-move drag is 200 absolute placements rather than 200 accumulated additions.
No compounding float drift, and an aborted gesture leaves no residue.

**A multi-selection resizes in world axes.** There is no shared angle to inherit,
so `selectionBounds` returns `kind: 'multiple'` with `rotation: 0` and each
member scales proportionally inside the group box while keeping its own rotation.
That is approximate for rotated members - a rotated element inside a
non-uniformly scaled group should shear, and it does not - and it is what every
2D editor does and what users expect.

---

## 10. Checklist for reviewing a coordinate change

1. Does the variable name say its space? `screenPoint`, `worldPoint`, `dxWorld`.
   A bare `x` crossing a function boundary is the bug.
2. Is it a **position** or a **displacement**? Positions convert with pan,
   displacements without. If it converts correctly at `zoom === 1` only, this is
   the reason.
3. Is the conversion in `coords.ts`? Any inline `(e.clientX - pan.x) / zoom`
   elsewhere is a defect regardless of whether it happens to be right.
4. Should this scale with zoom? Element geometry yes; handles, outlines, hit
   tolerances, and grab padding no.
5. Does DPR appear anywhere outside `Renderer.resize` and
   `Renderer.applyWorldTransform`? It should not.
6. Is a rotated element's extent computed with `rotatedBounds`, not with its raw
   `{x, y, width, height}`?
