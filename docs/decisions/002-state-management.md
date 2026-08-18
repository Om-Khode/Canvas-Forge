# ADR 002 - State management: Zustand, with the canvas outside React

**Status:** accepted, implemented
**Code:** `src/store/`, `src/components/canvas/`

## Problem

An editor writes to state at pointer frequency. A drag produces 60–120 updates per second, each of which must reach the canvas, the properties panel's position fields, and nothing else. The store choice has to answer two questions: where does document state live, and how does a high-frequency write avoid re-rendering the world?

## Options considered

**React Context + `useReducer`.** No dependency, idiomatic. Fatal flaw for this workload: a context value change re-renders _every_ consumer, with no selector mechanism. During a drag that is the entire subscribed tree, 60 times a second. The standard mitigations - splitting into many contexts, or `useSyncExternalStore` over a hand-rolled store - converge on reimplementing a state library, worse.

**Redux Toolkit.** Mature, excellent devtools, `useSelector` gives the narrow subscriptions this needs. The cost is ceremony: slices, actions, and a reducer indirection for what is often a two-line mutation, plus a larger dependency for a single-user local app with no middleware requirements.

**Zustand.** A small store with selector-based subscriptions, usable both as a React hook and imperatively via `getState`/`subscribe`.

**Keep the document outside React entirely** in a plain observable class, with React reading only what it displays.

## Decision

Zustand, one store composed from six slice creators (`elements`, `selection`, `viewport`, `tool`, `ui`, `history`). Plus the fourth option applied selectively: **the canvas component subscribes imperatively and never re-renders.**

## Why

Zustand's `useStore(selector)` gives the narrow subscriptions Context can't, at a fraction of Redux's ceremony. For a local-first app with no async middleware, no server cache, and no time-travel requirement beyond our own history system, Redux's structure is cost without return.

The more important half of this decision is the second one. `useCanvasStore` is not only a hook - it is also an imperative handle. The canvas component mounts once, subscribes with `useCanvasStore.subscribe`, and calls `renderer.markDirty()`. It renders `null` children and never re-renders when elements change. **A 60fps drag therefore does zero React work on the canvas path**: the store updates, the subscription fires, a frame is scheduled, the renderer paints. React is involved only where a human is reading a number off the screen.

This is why the engine's independence from React (ADR 001) and this store choice are really one decision. Neither works without the other.

Two structural choices inside the store are worth stating:

**Selection is its own slice holding a `Set<ElementId>`, never a flag on the element.** Putting `selected: boolean` on an element means every click mutates the document - which means it enters history (Ctrl+Z would undo a click), dirties autosave, and gets written into the saved file. Selection is view state _about_ the document, not part of it. As a set of ids it also makes shift-click, select-all, and multi-select maths direct set operations.

**The viewport is in the store but excluded from history.** The renderer needs it, the toolbar displays the zoom percentage, and it is serialised with the project so reopening restores your position - but nobody expects undo to reverse a scroll.

## Trade-offs

**Selector discipline is a convention, not a constraint.** Nothing in Zustand prevents `useCanvasStore(s => s.elements)` in a panel, which would re-render that panel on every frame of a drag. The codebase treats that as a bug rather than a performance nit, and exports ~20 pre-narrowed hooks (`useElement(id)`, `useSelectionCount`, `useZoom`) so the correct thing is also the easy thing. Redux's `useSelector` would have had the identical exposure.

**Slices share one flat state object** rather than nesting under keys. This is what lets `elementsSlice` call `get().applyDocument(...)` and keeps the single write path into history honest. The price is that slice names must not collide, so they are reviewed as one surface.

**No devtools time-travel.** Zustand has a devtools middleware, but our own history system is the thing that actually matters for this app and it is purpose-built (ADR 003).

**The imperative canvas subscription is easy to get wrong.** It bypasses React's lifecycle, so the subscription and the renderer both have to be torn down explicitly on unmount, and a stale `getScene` closure would silently render old data. Contained to one hook (`useRenderer`) precisely so there is one place to get it right.

## Consequences

- `src/store/index.ts` exports narrow typed hooks plus a `useShallow`-based helper for selectors that build a fresh array or object each call.
- Non-React consumers - the renderer, the autosave scheduler, the command table - read `useCanvasStore.getState()` directly. That the store works outside React is load-bearing, not incidental.
- The properties panel's numeric fields stay locally controlled while focused, so typing "1" en route to "100" doesn't push an intermediate value through the store per keystroke.
- Transient interaction state (in-flight drag delta, marquee rectangle, draft shape) lives in the interaction layer and never enters history.
- If this app ever gained multiplayer, the store would be the wrong seam: CRDT or OT integration wants operations, not snapshots, and would push work down into a document model beneath the store. Noted in the README as future work rather than designed for speculatively.
