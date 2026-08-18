# Actual Problems Encountered

A running log of real technical problems hit while building CanvasForge - what broke, how it was diagnosed, and what fixed it. This is the raw material for `interview/challenges.md`.

**Rules for this file:**

- Only real problems. Nothing invented, nothing anticipated-but-never-happened. A fabricated war story collapses under one follow-up question in an interview.
- Write the entry when the problem is fresh, while the debugging path is still remembered.
- "I read the docs and did it right the first time" is not a problem. Design _decisions_ belong in `docs/decisions/`; this file is for things that went wrong.
- Include the wrong hypotheses too. "I assumed X, measured, and X was not the cause" is often the most convincing part of the story.

**Template:**

```markdown
## NNN - Short title

**Phase:** which phase / what was being built
**Symptom:** what was observed, concretely

**Why it happened**
Root cause, not the surface description.

**How it was debugged**
The actual path - what was suspected first, what ruled it out, what confirmed the cause.

**Solution**
What was changed. Reference `file.ts:line` where useful.

**Alternatives considered**
Other fixes that would have worked, and why they lost.

**What was learned**
The generalizable part.
```

---

<!-- Entries below, newest last. Number them 001, 002, … -->

## 001 - Redo collapsed onto undo in the shortcut registry

**Phase:** shortcut registry (`src/features/shortcuts/chord.ts`)
**Symptom:** A unit test asserting that `Ctrl+Shift+Z` runs redo failed - the chord resolved to the undo command instead. `Ctrl+Shift+Z` and `Ctrl+Z` were producing the _same_ canonical chord string.

**Why it happened**

`chordFromEvent` deliberately dropped the shift flag for printable keys. The reasoning was real and, for punctuation, correct: `Shift+/` arrives with `event.key === '?'`, so the shift state is already encoded in the character, and recording it as well would force every table entry to spell out the same fact twice (`shift+?`).

That reasoning does not survive contact with letters. `Ctrl+Shift+Z` arrives with `event.key === 'Z'`. The registry lowercases keys so that `Z` and `z` are the same shortcut - and once lowercased, the only surviving trace of the shift key was the flag that had just been thrown away. `mod+shift+z` and `mod+z` both normalized to `mod+z`, and the Map lookup returned whichever was registered first.

**How it was debugged**

The failing assertion named the case directly, so there was no search involved - but the first instinct was wrong. The suspicion was a registration-order problem in the `byChord` Map, since the symptom (one of two commands always winning) looks exactly like a collision. Logging the normalized chord for both events ruled that out immediately: both events produced the identical string `mod+z`, so the Map was behaving correctly and the bug was upstream in normalization.

**Solution**

One rule, no exceptions: always record `event.shiftKey`, always lowercase `event.key`. `mod+shift+z` and `mod+z` are now distinct chords. `src/features/shortcuts/chord.ts:chordFromEvent`.

**Alternatives considered**

- _Keep the printable/non-printable split and special-case letters._ Two rules that disagree, with the disagreement landing on the most-used shortcut pair in the app. Rejected - the special case is exactly where the bug lives.
- _Switch to `event.code`._ `KeyZ` is unambiguous and unaffected by shift. Rejected because `code` reports physical US-layout positions: on AZERTY, `KeyZ` is where W is, so every letter shortcut would land under the wrong finger.

**What was learned**

The cost of the fix is that a punctuation shortcut must now be written the way the event reports it (`shift+?` rather than `?`) - slightly redundant, and worth it. When a normalization rule needs an exception, the exception is usually where the bug will be; a uniform rule with a small ergonomic cost beats a clever one with a carve-out.

Also: a test that fails on the _second_ thing you write is cheap. This bug is nearly invisible by inspection and would have shipped as "redo sometimes doesn't work" - the kind of thing users report vaguely and never reproduce.

---

## 002 - The properties panel displayed 100% opacity as "10"

**Phase:** first end-to-end run of the assembled editor
**Symptom:** With a fully opaque text element selected, the Appearance section's opacity field read `10 %`. The element was visibly at full opacity, and the underlying value was correct.

**Why it happened**

Not a units bug, which is what it looks like. The field's value was `100`; the `<input>` was 29 CSS pixels wide with 38 pixels of content, so the browser simply clipped the last digit.

The layout was a two-column grid inside a 256px panel (`w-64`, sitting in a `w-68` rail). Each cell got ~112px, from which the word label "OPACITY" took ~52px and the `%` suffix another ~20px. `NumberField` put `min-w-0` on its input so it could shrink inside a flex row - which meant that under pressure the _input_ was the thing that yielded, down to a size that could not show its own value.

**How it was debugged**

The screenshot alone is genuinely ambiguous - "10" is exactly what a `value * 10` bug would print, and that was the first hypothesis. Reading `AppearanceSection` disproved it: the multiplier was `* 100`, correct. Rather than keep reading, I queried the live DOM for every input's `value`, `clientWidth` and `scrollWidth`. That returned `value: "100", clientW: 29, scrollW: 38, clipped: true` and ended the investigation immediately - the value was right and the box was too small.

**Solution**

Two changes, because the first is a guard and the second is the actual fix.

1. `NumberField` now puts a `min-w-[4.5rem]` floor on the field _box_ and lets the label `truncate` instead. Flexbox shrinks the box to that floor and then takes the remainder out of the label. When something must give, it is now the label: a clipped label still reads, and screen readers get it in full regardless, whereas a clipped number is the field lying about the document. (`src/components/common/NumberField.tsx`)
2. The panel stopped pairing fields whose labels are words. `X`/`Y` and `W`/`H` still share a row because their labels are one character; Opacity, Radius and Angle are now full width. (`sections/AppearanceSection.tsx`, `sections/PositionSection.tsx`)

**Alternatives considered**

- _Shorten the label to "OP"._ Cheapest, and it damages the accessible name - the label element is also the field's programmatic name.
- _Only fix the guard and leave the layout._ The value would have been correct, but every narrow field would render a truncated label, which looks broken. The guard should be the thing that never fires in practice.
- _`hideLabel`._ Not available here: the label is also the drag-to-scrub handle, so hiding it removes an interaction.

**What was learned**

The general lesson is about where a layout yields under pressure. `min-w-0` is the standard fix for "a flex child refuses to shrink", and it had been applied to the input reflexively - but it makes the input the most compressible thing in the row, which is precisely backwards when the input is the only element carrying information.

The narrower lesson is about verification. Every one of the 577 unit tests passed with this bug present, and they would have kept passing: the component received the right prop and rendered the right value. Nothing short of measuring the rendered box could catch it. Some classes of defect are only visible in a browser, and "the tests are green" is not a substitute for opening the thing.

---

## 003 - Opening a project could crash the canvas with a stack overflow

**Phase:** performance work; surfaced by loading a 2,000-element stress document
**Symptom:** `RangeError: Maximum call stack size exceeded`, caught by the canvas `ErrorBoundary` - so the editor showed its "something went wrong" panel instead of a canvas. Reproduced every time with `?stress=2000`, and intermittently when opening any project.

**Why it happened**

`frameWhenLaidOut` in `useProjectSession.ts` frames a newly opened project by zooming to fit its contents. That needs the canvas to have been measured, and on a fresh load it hasn't been, so the function subscribes to the store and waits for a write that carries a viewport size.

The listener called `fit()`, and `fit()` **writes the viewport** - which synchronously re-enters the same listener, which calls `fit()` again. The `holder.unsubscribe?.()` that would have broken the cycle sat on the line _after_ the call, and was never reached.

It stayed hidden because the common path returns early: if the canvas is already measured, the first `fit()` succeeds and no subscription is ever created. The recursive branch only runs when a project is opened before the canvas has laid out - which is exactly what a stress-document load, or a slow first paint, produces.

**How it was debugged**

The stack trace was a single frame repeated, which points at unbounded recursion rather than deep nesting, and the repeated frame named the subscriber. From there the read was direct: the listener mutates the state it is subscribed to, before detaching.

**Solution**

Invert the order. The listener now tests readiness **without writing** - reading `viewportSize` off the store - then detaches, then calls `fit()`. A `framed` latch guards the window between the read and the detach. `src/features/project/useProjectSession.ts`.

**Alternatives considered**

- _Unsubscribe before `fit()` but keep `fit()` as the readiness test._ Works, but couples "am I ready" to "do the thing", so the next person to add an early return inside `fit()` reintroduces the bug.
- _Defer the fit with `queueMicrotask`._ Moves the recursion rather than removing it - the re-entrant write still happens, just later.
- _A `once`-style subscription helper._ The right shape if this pattern recurred. It occurs once.

**What was learned**

A store subscriber that writes to the store is a loop unless something breaks it, and "unsubscribe after the work" is not that something. The general rule this produced: **a listener must reach a stable state before it triggers any write** - detach first, act second.

Worth noting where this was found. Nothing in the test suite exercises "open a project before the canvas has been measured", and the bug is invisible on a fast machine with a small document. It took generating a document large enough to delay first paint.

---

## 004 - The canvas kept its old colours after switching theme

**Phase:** performance work; noticed while capturing minimap screenshots in both themes
**Symptom:** Toggling dark mode re-themed the toolbar, panels and dialogs instantly, while the canvas kept its previous background and dot-grid colour until a full page reload.

**Why it happened**

The engine reads its palette from the `--cf-*` CSS custom properties via `getComputedStyle` and caches the result, because doing that per frame would mean a forced style recalculation sixty times a second. `engine/theme.ts` exports `refreshTheme()` as the explicit invalidation, and its comment says the theme toggle is responsible for calling it.

Nothing called it. A repository-wide search for `refreshTheme` returned exactly one hit: its own definition.

The theme itself lives outside the Zustand store by design - it is a `data-theme` attribute plus a `useTheme` hook - so a flip produces no store write, and the renderer's two subscriptions (store changes, image decodes) both correctly ignored it. Every layer behaved exactly as designed; nobody owned the wire between them.

**How it was debugged**

Not debugged so much as noticed, in a screenshot comparison across themes. The cache was the immediate suspect, and one grep confirmed the invalidation had no callers.

**Solution**

`useTheme.ts` now exports `subscribeTheme`, and `useRenderer` subscribes to it, calling `refreshTheme()` and then `markDirty()`. That places the wire in the hook that already owns every other reason the renderer repaints. `src/components/canvas/useRenderer.ts`.

**Alternatives considered**

- _Call `refreshTheme()` from the theme toggle._ Puts a rendering concern in a UI control, and would need repeating at every other place the theme can change (system preference, `clearThemePreference`).
- _Drop the cache and read the palette per frame._ Correct by construction, and it trades a one-line subscription for a forced style recalc every frame - the precise cost the cache exists to avoid.
- _Put the theme in the store after all._ Would have made this work for free via the existing subscription. Rejected: it would also mean the theme is snapshot by history and serialised into the project file, which is worse.

**What was learned**

A cache with a documented invalidation function and no caller is indistinguishable from a cache with no invalidation at all, and a comment saying "the toggle is responsible for this" is not a mechanism - it is a hope. Where an invalidation _must_ happen, subscribe to the source rather than asking a distant caller to remember.

This is also the second bug in this log (with 002) that no unit test could have caught and that a browser found in seconds. Both are cross-layer wiring gaps, where each side is individually correct. That is now a known blind spot of the suite, and it is written up in `docs/testing.md`.

---

## 005 - Virtualization that measured a div nobody could see

**Phase:** virtualizing the layers panel
**Symptom:** The windowing hook was written, its unit tests passed, and in a real browser the panel still rendered all 2,000 rows - 45,231 DOM nodes, exactly as before. The sizer element had the correct 64,008px height and the container had a correct 331px viewport, so the layout was right and the window was simply never applied.

**Why it happened**

The hook took a `RefObject<HTMLElement | null>` and bound its `scroll` listener and `ResizeObserver` inside a `useEffect` keyed on `[containerRef, measure]`. Both are stable, so **the effect ran exactly once, ever**.

That is fine while the element is stable, and the element is not. The panel renders an `EmptyState` instead of the grid when there are no layers, so the grid `<div>` unmounts and a _new_ one mounts whenever the list goes from empty to non-empty. Loading a project does precisely that: the store is cleared, the panel shows its empty state, then the document arrives. The listeners stayed attached to the discarded div, the initial measurement had been taken against it, and `viewportHeight` stayed 0 forever - which lands on the hook's deliberate "render everything" fallback. The fallback did its job perfectly and hid the bug: the panel looked correct, just slow.

**How it was debugged**

The unit tests were no help, and that is the interesting part - they stub `clientHeight` and render the panel directly, so the grid element is never replaced and the code path never occurs.

In the browser, the first check was whether the container was height-constrained at all, since a scroll container that grows to its content would also produce a full render. It was constrained: `clientHeight` 331, `scrollHeight` 64,008. That eliminated CSS and pointed at the measurement never reaching React state. Dispatching a synthetic `scroll` event at the container changed nothing, which ruled out a stale-state bug and left only one explanation: nothing was listening to _this_ element.

**Solution**

The hook now takes the element itself rather than a ref, and the panel supplies it through a callback ref that also mirrors into a `useRef` for the stable handlers. `container` is a dependency the effect can actually react to, so the listeners re-bind whenever the node changes. `src/components/panels/useVirtualRows.ts`, `LayersPanel.tsx`.

**Alternatives considered**

- _Keep the grid always mounted and move the empty state inside it._ Fixes this instance and leaves the hook a trap for the next caller.
- _Poll, or re-measure on every render._ Hides the problem behind work.
- _Add the row count to the effect's dependencies._ Would have re-run the effect at the right moment by coincidence, and broken again the first time the element was replaced for some other reason.

**What was learned**

**A ref is not a dependency.** `useEffect(..., [someRef])` reads as though it tracks the element and tracks only the ref object, which never changes - so any effect that attaches to `ref.current` silently keeps attaching to the first node it ever saw. When an effect's subject is a DOM node that can be replaced, the node has to arrive through state.

The second lesson is about safe fallbacks. The "unmeasured means render everything" path was a deliberate choice, and it was right - but it converted a total failure into a silent performance regression, which is precisely the kind of bug that ships. A fallback that is invisible when it fires deserves something that makes the firing visible; the browser measurement in `docs/performance.md` §7 is now that check.

---

## 006 - A one-line type comment made twelve call sites lie, and nothing failed

**Phase:** element grouping - narrowing `ElementStore.order` to root-level ids
**Symptom:** Grouping two rectangles made them **disappear from the canvas**. Later, with rendering fixed, grouped content painted on canvas and was still missing from the minimap, from PNG export, from SVG export, and from every zoom-to-fit calculation. The full test suite - about 900 tests at the time - was green through all of it.

**Why it happened**

Groups store membership on the group (`GroupElement.childIds`), so `ElementStore.order` narrowed from "every element in the document, bottom to top" to "every **root-level** element, bottom to top". The type is unchanged: `readonly ElementId[]` before, `readonly ElementId[]` after. Only the comment above it changed.

`elementsInOrder`, the selector that maps `order` through `byId`, had twelve production call sites. All twelve kept compiling, kept returning a `readonly CanvasElement[]`, and started returning a different set of elements. The renderer built its scene from it, so a grouped element was never painted. Hit-testing used it, so a grouped element was never clickable. `ExportDialog`, `ZoomControls`, the minimap, `EditorPage`, `useProjectSession` and the image-naming pass all used it for bounds or for a name scan.

The reason the suite was blind is structural, not an oversight. These tests build `ElementStore` literals directly and assert on the module under test. Almost none of them route through the selector, so a selector whose *inputs* are unchanged and whose *contract* changed is invisible to every one of them.

**How it was debugged**

Not by debugging, which is the point of the entry. Every instance was found by reading code.

The first sighting was concrete: after grouping landed, grouping two shapes made them vanish, and the trace was short - `withSingleHome` prunes members out of `order` to enforce one-home-per-element, and `useRenderer` builds its scene from `order`. That looked like a local bug in the renderer's selector, and the obvious fix was to swap in a tree walk there.

That framing was wrong, and three later reviews are what showed it. The SVG export task reported the same defect in its own file. The transform task independently hit the PNG side of the same `ExportDialog` call site. The review *of that task* found the minimap: it fed the flat array to a `Renderer`, and `drawGroup` paints nothing by design, so a grouped document drew a blank overview - grouped content visible on canvas and absent from the map beside it.

Three independent sightings of one defect, from three directions, is the signal that it is not local. A grep for `elementsInOrder` then inventoried all twelve, and each was classified by what its caller actually wanted rather than by pattern-matching a replacement.

**Solution**

Two commits, deliberately split by whether the fix was semantic or mechanical.

The rendering and hit-test call sites are semantic: "what is pickable" and "what is painted" are questions grouping *changes the answer to* - a hidden group's members must not paint, an ancestor's opacity must multiply in - so those got `elementsToPaint` in `features/elements/tree.ts`, which folds inherited opacity, visibility and lock into a flat array (`ef8c85c`).

The remaining seven were one mechanical substitution repeated, and landed together (`8579cdc`), with the three export shapes lifted into `features/export/scope.ts` because "which walk does this exporter want" turned out to have three different right answers and was being re-derived at each call site. `createCommands.ts`'s select-all was **verified and left alone** - root ids are the correct answer there, since selection resolves to outermost ancestors - and pinned with a test so a later sweep does not "fix" it.

Every one of the seven got a test that reaches through the **real** selector, which is the only shape of test that could have failed. Four new test files - `export/scope.test.ts`, `ExportDialog.test.tsx`, `ZoomControls.test.tsx`, `useProjectSession.test.ts` - exist for no other reason.

**Alternatives considered**

- _Change `elementsInOrder` itself to walk the tree._ The single smallest edit, and it flips the defect's polarity instead of fixing it: the genuinely root-scoped callers (select-all, and the root reorder path) would then silently get members they must not have. It is the right selector for the question it asks; the callers were asking a different question.
- _Add a `deep?: boolean` parameter._ Same defect with an opt-in, and every call site still has to be visited to decide - with no compiler help, and a default that is wrong for someone.
- _Rename `order` to `rootOrder`._ This one was **not** considered at the time, and in hindsight it is the fix that would have prevented the whole episode: renaming the field along with its meaning would have turned a silent semantic drift into a compile error at every site that reads it. It is recorded here as the option that was missed, not as one that was weighed and rejected.

**What was learned**

**Broadening a type is caught by the compiler. Narrowing the meaning of a value inside an unchanged type is caught by nothing.** There is no tooling between a comment that used to be true and one that is. The only mechanical defence is to change the *name* along with the meaning, so the compiler can enumerate the call sites - and that trade (a wide rename now against a silent semantic drift later) is now something to decide deliberately rather than by default.

The second lesson is about the shape of a test suite rather than its size. This one is fast and precise because it builds fixtures and tests pure functions, and that is the right default. It also means the suite has almost no coverage of *contracts between* modules, which is exactly where this defect lived - and it is the same blind spot `docs/testing.md §4` records for entry 002, reached from the opposite direction. A number of tests says nothing about it. The fix is not more tests; it is a handful of tests that deliberately reach through the real wiring at the seams that matter.

---

## 007 - The angle field read the one number in the document nothing ever writes

**Phase:** element grouping - properties panel (`src/features/properties/rotation.ts`)
**Symptom:** Found by driving the editor in a browser, not by a test. Rotate a group with the canvas handle and it turns on screen exactly as it should - while the properties panel's ANGLE field reads **0**, every time, and is greyed out. Nothing in the app disagreed with itself loudly enough to fail.

**Why it happened**

The 0 was correct data, displayed against the wrong subject. A group owns no rotation of its own: `rotateElements` is applied to the group's **leaves**, orbiting each about the group's centre and adding the delta to each leaf's own `rotation`, and the group's box is then re-derived as the axis-aligned union of the rotated leaves. `derivePass` re-derives `x`/`y`/`width`/`height` and deliberately leaves `rotation` alone. So `group.rotation` is the one field in the document that no gesture writes and no derivation rewrites - and the panel was reading precisely that.

The disabled state was the second half. It was added as a stopgap in the same review round that found panel edits to a group's box being silently erased: X/Y/W/H genuinely cannot be written on a group, rotation was switched off alongside them because at the time writing it would have persisted a number onto a group whose members never moved, and the field went out disabled with the write path deferred. The spec had said "rotation reads 0 and writing it rotates the descendants" all along, so the divergence was recorded rather than noticed later.

**How it was debugged**

There was nothing to debug in the usual sense - the cause was one grep from the symptom. The work was in deciding what the field should *mean*, which is genuinely ambiguous, and two answers were on the table:

1. set every leaf's absolute rotation to N, or
2. rotate the group as a unit so that it reads N - apply the delta `N - current` about the group's centre.

(1) is what the field already did for loose elements and is one line. It is also wrong here: a user who has just dragged the rotation handle to 30° and types 45 expects the remaining 15° of the same motion, and (1) instead spins every member in place about its own centre, leaving the arrangement pointing the wrong way. (2) is the identical call the handle makes - for one event, which is all a *typed* value is. It shipped as a per-event `N - current` against the live document, and that turned out to be the same call only for the typed path; the label also **scrubs**, at a hundred events per drag, and entry 008 is what that cost.

The trap was in the no-op case, and it only showed up when the tolerance was tested by deliberately removing it. `normalizeAngle` is **not** bit-idempotent - `((x % 2π) + 2π) % 2π` returns a value up to 8.9e-16 away from `x` for about 70% of inputs - so a zero delta fed through it mints a new number, `patchDocument`'s value comparison sees a change, and history records an entry. Reverting the tolerance to `0` and re-running made a click on the ANGLE label that moved nothing orbit every member of the group by 1.8e-14 world units and cost an undo entry.

**Solution**

`features/properties/rotation.ts` holds both halves, pure and store-free: `rotationTargets` (a group stands in for its lock-filtered leaves; a directly selected locked element stays, since the panel deliberately edits those) and `rotationPatches` (the delta, about the pivot the handle uses). The panel reads and writes through the same set, so the number on screen describes what an edit would change. `ROTATION_NOOP_RADIANS = 1e-9` is the tolerance: six orders of magnitude below the smallest edit a field showing one decimal of a degree can express, and above any float residue.

Leaves that *disagree* have no shared `current` to subtract, so there is no delta; each leaf takes the typed angle in place, every centre stays put, and the field still ends up reading N.

Position and Size stayed disabled for a group at the time of this entry, on the same "a patch naming a derived box is erased by the write it lands in" reasoning. A user pointed out the hole in it - the canvas moves and resizes a group perfectly well, by patching the leaves - and they were wired through the identical snapshot-and-replay shape in `features/properties/geometry.ts` shortly after. `rotationTargets` moved to `features/properties/targets.ts` at that point, since both fields need the same answer to "which elements may this land on".

**Alternatives considered**

- _Make the whole angle field rigid, loose multi-selections included._ Strictly more consistent with the canvas handle, which orbits a multi-selection too. Rejected as a behaviour change outside the reported defect: a group is one object by definition, five loose shapes are five objects the panel has always edited individually, and quietly making them fly around each other is not a bug fix.
- _Derive a group's `rotation` from its leaves._ Then the field could read the group again. It also makes `rotation` a second derived field, and the moment leaves disagree there is no value to derive - the honest answer is "Mixed", which a single number cannot carry.
- _Keep the field disabled and document it._ What was already shipped, and what the user reported. A field that displays a value it will never update is worse than no field.

**What was learned**

**A read path and a write path that disagree about their subject produce a display bug with no failing test anywhere.** The panel wrote to leaves and read from the container, and every unit test on both sides passed because each was self-consistent. The rule that came out of it is the one the fix is built on: read from the same set you write to, and the field cannot lie about what an edit would do.

The second lesson is that a guard is worth exactly what its counter-test proves. `ROTATION_NOOP_RADIANS` looks like defensive noise until the constant is set to `0` and a test fails; that inversion is now the standard for keeping a tolerance in this codebase.

---

## 008 - Scrubbing the ANGLE label walked the group across the canvas

**Phase:** element grouping - properties panel, review of the fix in 007 (`src/features/properties/rotation.ts`)
**Symptom:** Drag the rotation handle to 90° and the group turns in place. Drag the ANGLE **label** to 90° - the same control, the same number - and the group ends up somewhere else entirely, up to 77 world units away. Do it slower, or on a faster machine, and it stops somewhere different again.

**Why it happened**

`NumberField`'s label is a scrub handle: it fires `onChange` **once per pointermove**, and at 2px per step that is easily a hundred calls in one drag. Entry 007's write path read the live document on every call - `delta = target - current`, pivot re-measured from `selectionBounds(transformSet(...))` - which is exactly right once and wrong a hundred times in a row.

A group's pivot is the centre of the union of its leaves' **rotated** boxes, and that centre is *not* invariant under rotation about itself unless the group is symmetric. So each event rotated about a pivot the previous event had moved, and one hundred 1° rotations about one hundred slightly different centres is not a 90° rotation about one. The rotate *gesture* never had the bug because it snapshots the leaves and the centre at `beginTransaction` and replays the absolute total angle against that frozen state every frame - fixed pivot, no composition.

Measured on a deliberately asymmetric group (a 200×10 bar, a 10×10 square, a 40×120 box):

```
one 90° commit :  a(310.00, 200.00)  b(205.00, 405.00)  c(-65.00, 115.00)
90 × 1° commits:  a(234.93, 216.45)  b(129.93, 421.45)  c(-140.07, 131.45)
MAX DRIFT: 76.852 world units      (the angles are identical)
```

How far it drifts is a property of the arrangement, not a constant: the regression fixture places the same three shapes differently and lands 27.7 units out over the same 90°.

**How it was debugged**

Found in review, by reading the two paths side by side rather than by running anything: the gesture holds a `GestureSnapshot`, the field held nothing. The measurement above came second, to decide whether it mattered - the angles agree exactly, so nothing in the app reports a problem; only the position drifts, and only for an asymmetric group.

The more useful question was why the test suite was silent, and the answer was the fixture. Its group is two 10×10 squares at opposite corners of a 50×50 box - **symmetric**, so its pivot really is invariant under rotation and the same hundred-step composition drifts 3.6e-15. The only scrub test was the zero-travel case, which never fires a moving event at all. Both tests passed on a fixture structurally incapable of showing the defect.

**Solution**

The field now mirrors the gesture's structure instead of inventing a second one. `rotationSnapshot(store, ids)` freezes what the gesture will act on - the lock-filtered leaves, the pivot from the unfiltered box, and the angle they started from - and `rotationPatches(snapshot, radians)` replays the **absolute** target against it. The panel takes that snapshot in the angle field's `onScrubStart` and holds it in a ref for the life of the drag; a typed value takes one at its single `onChange`, which is the same gesture one event long. A hundred events and one event therefore produce the same document, by construction rather than by luck.

One case needed care: a scrub that returns to the value it started from. The delta is then zero, but the document has moved, so "nothing to do" would be wrong - and `rotateElements(…, 0)` is not an option either, because `normalizeAngle` is not bit-idempotent (entry 007). The zero-delta branch writes the frozen geometry back **verbatim**, which restores the exact numbers, so `patchDocument` compares them equal and the gesture stays out of history.

The fixture was replaced rather than extended: the regression tests use an asymmetric group and assert (a) hand-computed positions for a rigid quarter turn, (b) that a 90-event scrub lands where one typed commit lands, and (c) that a 2-event and a 240-event scrub of the same travel land identically. All three fail by ~27 world units against the old code.

**Alternatives considered**

- _Throttle `onChange` to one per frame._ Fewer compositions, so less drift - but still drift, still frame-rate dependent, and it would have made the bug harder to reproduce rather than absent.
- _Re-measure the pivot but keep it fixed after the first event._ A snapshot with extra steps, and it leaves the "first event is special" branch to get wrong.
- _Compare against the live document to decide a no-op, instead of restoring the snapshot verbatim._ Correct, but it puts a store read back inside a function whose whole value is that it is pure, to answer a question `patchDocument` already answers.

**What was learned**

**"It calls the same function" is not the same as "it is the same operation."** The two paths shared `rotateElements` and still disagreed, because the operation is the function *plus* what it is applied to and how often - and one path was driven once per gesture while the other was driven once per pointer event. The invariant to check when a control has two input modes is not which code they share, but whether the result depends on the number of events.

**A fixture chosen for arithmetic convenience can be blind by construction.** The symmetric group was picked so a quarter turn landed on whole numbers, which made every assertion readable - and made an entire class of pivot bug invisible. Symmetry in a fixture is a hypothesis about which errors cancel; when the thing under test is a derived centre, that is exactly the hypothesis you must not make.

## 009 - Escape during a panel scrub killed undo for the rest of the session

**Phase:** element grouping - properties panel, review of the fix in 008 (`src/components/common/NumberField.tsx`)
**Symptom:** Start dragging any NumberField label, and - with the mouse still held - press Escape or Delete. Undo goes dead permanently: Ctrl+Z does nothing for the rest of the session, no matter what you edit next. On the ANGLE field it was worse than dead. Select a *different* element, type an angle, and that element stayed at 0° while the group you had deselected a minute ago turned instead.

**Why it happened**

A scrub is bracketed: `onScrubStart` opens a history transaction, `onScrubEnd` commits it. `onScrubEnd` was reachable **only** from the `pointerup`/`pointercancel` handler. The effect's cleanup detached those listeners and restored the cursor, and stopped there.

So the gesture had a second exit nobody had wired: the field can be **unmounted mid-drag**. A panel scrub leaves `interaction.kind === 'idle'`, so nothing disables the keyboard commands, and both `edit.clear-selection` (Escape) and Delete empty the selection - which swaps the whole Position/Size/Transform section out for the tool defaults. The pointer is still down; the field it was dragging no longer exists; no `pointerup` will ever reach it. The transaction stayed open at `depth === 1`, and `undo()` refuses to run while a transaction is open - deliberately, because mid-drag the document is in a state that was never committed. Correct guard, permanently tripped.

The angle field leaked a second thing. Entry 008 gave it a `RotationSnapshot` held in a panel ref for the life of the gesture, released in `onScrubEnd`. With `onScrubEnd` never firing, that ref survived the selection it described, and `rotate` reads `rotationScrub.current ?? rotationSnapshot(...)` - so the *next typed angle*, against a completely different selection, replayed the stale snapshot: it rotated the old group's leaves about the old pivot and wrote nothing to the newly selected element. The three older fields never showed this half because they hold no state between events; they read the live document each time.

**How it was debugged**

Found in review, then reproduced in a test before anything was changed: fire `pointerDown` + `pointerMove` on the ANGLE label, call `clearSelection()` inside `act`, assert `history.depth`. It came back 1 where 0 was required. The second half was pinned the same way and confirmed to be independently detectable - with only the ref-clearing line removed and the commit left in place, the test fails on the *rotation* assertion (`expected 0 to be close to 0.785`) rather than the depth one. Two halves, two failures, one fix.

**Solution**

The effect's cleanup now ends the gesture as well as unsubscribing. One local `release()` owns "end this scrub for the caller", and it is idempotent: the live scrub origin (`scrubRef.current`) is the flag, and it is cleared *before* `onScrubEnd` is called, so the store write inside the callback cannot re-enter it. `pointerup` releases before it clears `scrubbing`, which means by the time the cleanup runs on the normal path the ref is already null and the cleanup is a no-op - the guard is what keeps one gesture to one commit.

Fixed in `NumberField` rather than in the one caller that also leaks state, because the dead-undo half is shared by X, Y, W, H and opacity, and a component that can be torn down mid-gesture is the component that should know how to end one. The idempotence guard is not defensive margin around the new call site - it is what the new call site requires. `onUp` calls `release()` and then `setScrubbing(false)`, and that state flip reruns the effect and fires the very cleanup this commit just added, which calls `release()` a second time in the same tick. With the guard removed, the pre-existing `brackets the drag with scrub callbacks` test fails at 2 calls instead of 1 - and that test fires only `pointerDown`/`pointerMove`/`pointerUp`, no `pointercancel` anywhere, so the second call is the cleanup this change introduced, not some double-fire that predated it. (The `pointercancel`-then-`pointerup` sequence was never the culprit: per the Pointer Events spec no `pointerup` follows a `pointercancel` for the same pointer, and running HEAD's `does not end the same scrub twice` test - the one that does fire cancel then up - against the pre-fix `NumberField` passes, because the listeners are already detached by the time `pointerup` would have arrived.)

**What was learned**

**Every bracketed gesture needs its cleanup counted as an exit, not as bookkeeping.** `onScrubStart`/`onScrubEnd` reads like a pair, and the code treated it as one - the open half in a pointer handler, the close half in the matching pointer handler. But a React component has an exit the DOM event model knows nothing about, and unmount is not an error path: here it is a *documented keyboard shortcut* firing while the mouse is down. The question to ask of any acquire/release pair in a component is not "does the release fire on the happy path" but "how many ways can this component stop existing, and does each of them release?"

**A leaked resource that only breaks a *global* feature is invisible in the moment.** Nothing went wrong on screen when Escape ended the scrub - the selection cleared, the panel updated, the numbers were right. The cost surfaced minutes later as "Ctrl+Z is broken", with nothing to connect it back to. Autosave was watching the same flag (`selectIsTransactionOpen`), so it had quietly stopped too.

## 010 - The aspect lock wasn't broken; it was standing in the wrong row

**Phase:** post-grouping UI polish (`src/components/panels/sections/PositionSection.tsx`)
**Symptom:** Reported from a live browser session, not a test: "toggling the aspect-ratio lock on one element locks it for *every* element, and unlocking unlocks for all." Expected per-element. Everything about the report was accurate.

**Why it happened**

The behaviour was correct and deliberate. `lockAspect` is a single flag in `uiSlice` and always has been - `git log` puts it well before the grouping work, so it wasn't a regression - because the canvas resize handles read it too: `preserveAspect = modifiers.shift || context.lockAspect` (`machine.ts`). It is a tool mode, "Shift held permanently", not a property of a shape. Making it per-element would leave a multi-selection corner drag with mixed flags undefined, and would need a new rule for the handles that nothing else in the editor needs.

What was wrong was the **affordance**. The toggle was an icon button (`Link`/`Link2Off`) sitting in the same `flex` row as the W and H `NumberField`s. Every other control in that row is a property of the selected element, so the lock inherited that reading by adjacency - it looked like the third field in the size row. Figma does store this per node, so the user's expectation had a precedent to point at; the control simply looked like the other product's version of itself.

**How it was debugged**

There was nothing to debug in the code path, which is the point. The disagreement was between what the store does and what the panel appears to promise, and no test can fail on that - a test asserts behaviour, and the behaviour was right. It took a person looking at the panel.

**Solution**

No change to the flag, the store, or the canvas. The control moved out of the W/H row onto its own row inside the SIZE section, separated by a rule, and became a labelled `Toggle` - a switch, which is what this app already uses for a setting that takes effect immediately - with a description that says it in words: *"Editor-wide, not per element - stays on until you turn it off."* It stays inside SIZE because coupling W to H is the visible half of what it does, and moving it away would make that relationship unguessable. `role="switch"` with `aria-checked` also states the toggle semantics more precisely than the `aria-pressed` it had as an icon button.

A test now selects element A, turns the lock on, selects element B, and asserts it is still on. The behaviour was already there; nothing pinned it, so nothing said it was intended.

**What was learned**

**A "wrong behaviour" report can be a correct behaviour with a mislabelled control, and the fix belongs in the label.** The instinct on reading the report was to make the flag per-element - the user said so, and it is one refactor. That would have traded a working model for a broken one to satisfy a complaint about layout. The useful question was not "is the behaviour what they want?" but "what did the UI tell them the behaviour would be?", and the answer was: it sat in a row of per-element fields, so it promised to be one.

**Proximity is a claim about semantics.** Grouping a control with four others in a `flex` row asserts that it belongs to the same category. That assertion is unwritten, unreviewable, and read by every user before they read the tooltip.
