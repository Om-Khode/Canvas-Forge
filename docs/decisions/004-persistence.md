# ADR 004 - Persistence: IndexedDB, local-first, no backend

**Status:** accepted, implemented
**Code:** `src/services/idb.ts`, `projectRepository.ts`, `imageStore.ts`, `autosave.ts`, `src/features/project/`

## Problem

Projects have to survive a refresh, a browser restart, and a crash mid-edit. They contain images, which are large and binary. The app must also be honest about failure: storage can be full, blocked, or absent entirely, and a design tool that silently loses work is worse than one that refuses to start.

## Options considered

**localStorage.** Synchronous, trivial API, universally available. Three disqualifying properties: a ~5MB origin quota, string-only values (so an image must be base64, costing a further 33%), and synchronous access that blocks the main thread - writing a large project mid-interaction would drop frames.

**IndexedDB.** Async, large quota (typically a percentage of free disk), stores `Blob`s natively. Verbose event-based API.

**The File System Access API.** Real files the user owns, and the right long-term answer for a design tool. Chromium-only at time of writing, and requires a user gesture per handle, which rules it out as the _primary_ store.

**A backend.** Supabase, Firebase, or a bespoke service.

## Decision

IndexedDB for projects and image blobs, localStorage for small preferences, no backend.

## Why

**No backend, deliberately.** The spec forbids it for the MVP, but it is also the right call on its own terms: this app has no multi-user requirement, no sharing model, and no compute the client can't do. Adding a backend would introduce authentication, a deployment surface, a privacy story, and running costs, in exchange for nothing a user would notice. "Your work stays in your browser, no account required" is a genuine product position, not a limitation being spun. It is also what makes the app instantly usable by someone evaluating it - no signup wall.

**IndexedDB over localStorage** follows directly from images. A single 2400px photo is several megabytes; base64 in a 5MB string-only quota is not a design, it is a countdown. IndexedDB stores the `Blob` as bytes, and being async means a save never blocks a drag.

**localStorage is still used**, for theme, panel layout, and last-opened project id. Here its weaknesses are irrelevant and its synchronous read is an actual feature: the theme is applied by an inline script before first paint, which is why there is no dark-mode flash on load. Using the async store for that would guarantee the flash.

**The IndexedDB wrapper is hand-written** (324 lines, about 210 excluding comments) rather than `idb` or `idb-keyval`. Two reasons, one of which is not about the code. The honest one: how object stores, versioning, and transactions work is a reasonable interview question, and a library-shaped answer is a shallow one. The structural one: writing it ourselves made it natural to put it behind an injectable `StorageBackend` interface, and that turned out to matter more than the wrapper itself - see below.

Two implementation details that are easy to get wrong and were:

- **Writes resolve on `transaction.oncomplete`, not `request.onsuccess`.** The request succeeds when the write is queued; quota failures surface at commit. Resolving on the earlier signal would report a failed save as successful, which is the single worst bug this layer could have.
- **Safari in private mode throws synchronously from `indexedDB.open`.** Caught and surfaced as `unavailable` rather than propagating as an unhandled rejection.

**Services return `Result<T, E>` instead of throwing.** Quota exhaustion, corrupt files, and blocked storage are _expected_ conditions in a local-first app, not exceptional ones. Encoding them in the return type means the UI cannot forget to handle them - a `try`/`catch` is easy to omit and invisible when omitted, whereas an unhandled `Result` is a type error.

**`StorageBackend` is injectable**, with `createMemoryBackend()` alongside the IndexedDB one. This is the degradation path when storage is unavailable - and it is also what the repository tests run against. The fallback is therefore exercised by the test suite rather than being untested Safari-only code that first runs in front of a user, and no `fake-indexeddb` dependency was needed.

**Images are stored as blobs keyed by a content hash**, taken _after_ downscaling so the key identifies the stored bytes. Elements hold the key, never the pixels. Three consequences: the same image dropped ten times is stored and decoded once; history snapshots carry a short string per image element instead of megabytes; and blobs are shared across projects, so deleting a project mark-and-sweeps rather than deleting blindly.

**The storage format and the export format are deliberately different.** Stored projects reference blobs by key; exported JSON inlines images as data URIs so the file is self-contained. Conflating them would either bloat every save or produce an export that breaks the moment it leaves the machine.

## Trade-offs

**Browser storage is not durable.** Clearing site data destroys everything, and browsers may evict under pressure without asking. Mitigations: JSON export as the user-controlled backup, and a visible save-status indicator. The honest framing is that this is the cost of "no account required", and the product states it rather than hiding it.

**No cross-device sync.** Follows from having no backend.

**Quota is opaque.** `navigator.storage.estimate()` gives a rough figure but browsers deliberately fuzz it, so the app reacts to a quota error rather than predicting one.

**Schema migrations are forward-only.** A file from a _newer_ schema version is refused with a clear message rather than best-effort parsed - guessing at a format you don't know is how you corrupt someone's work while appearing to succeed.

**Autosave debounce is a data-loss window.** 800ms of unsaved work is possible on a hard crash. Shortening it would write during interaction; the scheduler is additionally blocked while a transaction is open, so nothing writes mid-drag, and `flush()` runs on `beforeunload`.

## Consequences

- Untrusted input is validated by hand-written type guards, with per-element granularity: a document containing one malformed element loads with the rest intact and reports what was dropped. A corrupt file should cost you one shape, not the project.
- Data-URI MIME types on import are checked against an allow-list. A project file is untrusted input and an image field is the obvious injection vector.
- The migration chain is built and tested against a synthetic v0→v1 upgrade even though the real chain is empty, so the mechanism is proven before it is needed rather than written under pressure at the first breaking change.
- Load warnings propagate to the UI rather than being swallowed.
- If durability became a requirement, the File System Access API is the next step for Chromium, with export-to-file as the cross-browser fallback - a smaller change than adding a backend, and it keeps the local-first property.
