/**
 * The intent executor: the only place an interaction intent becomes a store
 * write.
 *
 * Split from the hook because it is a different job. `usePointerInteraction`
 * plumbs DOM events - pointer capture, wheel listeners, the cursor - while this
 * file translates the machine's decisions into document changes. Keeping them
 * apart means the executor can be driven from a list of intents with no DOM at
 * all, and the hook's remaining bulk is genuinely about event handling.
 *
 * Gesture state is passed in rather than closed over, so the executor is a plain
 * function and the hook keeps ownership of its refs.
 */

import { hitTestRect } from '@/features/canvas/engine/hitTest';
import { insertImageFiles, pickImageFiles } from '@/features/images';
import type { DraftGeometry, InteractionIntent } from '@/features/canvas/interaction/protocol';
import {
  createArrow,
  createEllipse,
  createFreehand,
  createLine,
  createRectangle,
  createText,
  type ElementStyle,
} from '@/features/elements/factory';
import {
  resizeElements,
  rotateElements,
  translateElements,
  type ElementPatch,
  type ElementPatchMap,
} from '@/features/elements/operations';
import { elementsInPaintOrder } from '@/features/elements/tree';
import { selectionBounds } from '@/features/selection/bounds';
import { gestureTargets } from '@/features/selection/gestureTargets';
import {
  pointerEligibility,
  resolveSelectionTarget,
  resolveSelectionTargets,
  transformSet,
} from '@/features/selection/resolve';
import { selectActiveStyle, selectEnteredGroupId, useCanvasStore } from '@/store';
import { assertNever, type CanvasElement, type ElementId, type Rect } from '@/types';
import { worldRect } from '@/utils/coords';
import { rectFromPoints } from '@/utils/geometry';

/** Elements and the box they occupied when the current transaction opened. */
export interface GestureSnapshot {
  /** Lock filtered - what `translate` and `rotate` patch directly. */
  readonly elements: readonly CanvasElement[];
  /**
   * Unfiltered - every leaf the frame in `bounds` actually spans, locked ones
   * included. `resize` computes against this, not `elements`: see the case
   * below for why the two must not be conflated.
   */
  readonly frameElements: readonly CanvasElement[];
  readonly bounds: Rect | null;
}

/**
 * The mutable slots the executor needs across a gesture. Deliberately a bag of
 * refs owned by the caller: the hook already holds these to keep a gesture at
 * zero React renders, and duplicating them here would give two sources of truth
 * for "what is the draft element".
 */
export interface GestureRefs {
  snapshot: { current: GestureSnapshot | null };
  draftId: { current: ElementId | null };
}

export function executeIntents(
  intents: readonly InteractionIntent[],
  gesture: GestureRefs
): void {
  const { snapshot, draftId } = gesture;
  /**
   * The id `commitDraft` released, for a `beginTextEdit` later in the same
   * batch. Local to the call rather than added to `GestureRefs`: it never
   * outlives one batch of intents, and widening the shared ref bag would put a
   * lifetime that short next to two that span a whole gesture.
   */
  let committedDraftId: ElementId | null = null;

  for (const intent of intents) {
    // Re-read per intent: `beginTransaction` and `createDraft` both change what
    // the next intent in the same batch needs to see.
    const store = useCanvasStore.getState();
    switch (intent.kind) {
      /*
        Every id that reaches the selection is resolved here, against the group
        the user is currently inside. The machine deals in leaves - that is what
        hit-testing hands it - and this is the one place that knows which group
        those leaves should collapse into. Resolution is idempotent, so an id
        that was already resolved passes through unchanged; a double-click
        relies on exactly that, arriving as `enterGroup` then `select` in the
        same batch so the select lands one level *inside* what was just entered.
      */
      case 'select':
        store.select(
          resolveSelectionTargets(store.elements, intent.ids, selectEnteredGroupId(store))
        );
        break;
      case 'clearSelection':
        store.clearSelection();
        break;
      case 'toggleSelect':
        // Shift-click resolves first and adds second, so shift-clicking a member
        // of a group toggles the group rather than smuggling a leaf into a
        // selection that is otherwise made of groups.
        store.toggle(
          resolveSelectionTarget(store.elements, intent.id, selectEnteredGroupId(store))
        );
        break;
      case 'enterGroup':
        store.enterGroup(intent.groupId);
        break;
      case 'marqueeSelect': {
        const elements = elementsInPaintOrder(store.elements);
        const hits = hitTestRect(intent.rectWorld, elements, pointerEligibility(store.elements));
        const ids = resolveSelectionTargets(
          store.elements,
          hits.map((element) => element.id),
          selectEnteredGroupId(store)
        );
        if (intent.additive) store.addToSelection(ids);
        else store.select(ids);
        break;
      }
      /*
        The snapshot is the *transform set*, not the selection.

        With a group selected, `selectSelectedElements` returns the group
        element, whose box is a cache over its leaves - so `translate` would
        patch that box and `withDerivedGroups` would recompute it from the
        unmoved leaves in the same write, erasing the patch. The drag would move
        nothing, and resize and rotate take the identical path. Expanding to the
        leaves here is the whole of what makes a group draggable: group
        transform is not a new operation, it is the multi-selection one with a
        persistent name (see `features/selection/gestureTargets`).

        `elements` and `frameElements` deliberately read two *different* sets
        now, both `transformSet`-based but filtered differently. `elements` -
        `gestureTargets`, lock filtered - is what `translate`/`rotate` patch
        directly, and the only ids `resize` (below) is allowed to write.
        `frameElements` - unfiltered - is what `bounds` measures and what
        `resize` computes *against*: it has to be, because `resizeElements`
        special-cases a single element to resize in its own rotated frame
        rather than scale proportionally inside a shared box, a branch keyed
        on array length, not locks. Filtering before calling it - the way
        `translate`/`rotate` still correctly do, since their math has no such
        branch - would make a group of two with one locked member take that
        single-element branch by accident: the surviving leaf would be
        resized as if it alone occupied the whole frame instead of scaling in
        place inside it ("the surviving leaf snaps to the pointer", review
        round-1 finding 1). `frameElements` keeps the true count so the right
        branch fires; `resize` then discards every patch outside `elements`.
        This is also the box `usePointerInteraction.probeUnderPointer`
        hit-tests handles against (see that function), so the frame the user
        grabs a handle on agrees with the one the math replays against.
      */
      case 'beginTransaction': {
        store.beginTransaction(intent.label);
        const elements = gestureTargets(store.elements, store.selection);
        const frameElements = transformSet(store.elements, store.selection);
        const bounds = selectionBounds(frameElements);
        snapshot.current = {
          elements,
          frameElements,
          bounds: bounds.kind === 'none' ? null : bounds.rect,
        };
        break;
      }
      case 'commitTransaction':
        store.commitTransaction();
        snapshot.current = null;
        break;
      case 'abortTransaction':
        store.abortTransaction();
        snapshot.current = null;
        draftId.current = null;
        break;
      case 'translate': {
        const taken = snapshot.current;
        if (taken === null) break;
        store.applyPatches(
          translateElements(taken.elements, intent.deltaWorld.x, intent.deltaWorld.y),
          'Move elements'
        );
        break;
      }
      case 'resize': {
        const taken = snapshot.current;
        if (taken === null || taken.bounds === null) break;
        const patches = resizeElements(
          taken.frameElements,
          taken.bounds,
          intent.handle,
          intent.pointerWorld,
          { preserveAspect: intent.preserveAspect, fromCenter: intent.fromCenter }
        );
        // Computed against the full frame (so a locked sibling's presence still
        // picks the right proportional-vs-single-element branch), then narrowed
        // to what is actually allowed to move - a locked member gets a patch
        // above and must not receive it.
        const allowed = new Set(taken.elements.map((element) => element.id));
        const filtered: ElementPatchMap = Object.fromEntries(
          Object.entries(patches).filter(([id]) => allowed.has(id))
        );
        store.applyPatches(filtered, 'Resize elements');
        break;
      }
      case 'rotate': {
        const taken = snapshot.current;
        if (taken === null) break;
        store.applyPatches(
          rotateElements(taken.elements, intent.centerWorld, intent.radians, intent.snap),
          'Rotate elements'
        );
        break;
      }
      case 'createDraft': {
        // Every element at every depth: `buildDraft` only reads this to pick the
        // next free name suffix, and a root-level walk would hand the new shape
        // a name a grouped element already holds.
        const element = buildDraft(
          intent.draft,
          elementsInPaintOrder(store.elements),
          selectActiveStyle(store)
        );
        draftId.current = element.id;
        store.addElement(element);
        break;
      }
      case 'updateDraft': {
        const id = draftId.current;
        if (id === null) break;
        // Rebuilt through the factory rather than by recomputing geometry here:
        // normalized line endpoints and freehand points are the factory's
        // arithmetic, and a second copy of it is a copy that will drift.
        const rebuilt = buildDraft(intent.draft, [], selectActiveStyle(store));
        store.updateElement(id, geometryPatch(rebuilt), 'Draw');
        break;
      }
      case 'commitDraft': {
        const id = draftId.current;
        draftId.current = null;
        if (id !== null) store.select([id]);
        // Remembered because `beginTextEdit` arrives later *in the same batch*
        // with `elementId: null`, meaning "the draft that was just committed" -
        // and by then the ref that held it has been released.
        committedDraftId = id;
        break;
      }
      case 'panTo':
        store.setViewport({ ...store.viewport, panX: intent.panX, panY: intent.panY });
        break;
      case 'beginTextEdit': {
        const id = intent.elementId ?? committedDraftId;
        if (id === null) break;
        const element = store.elements.byId[id];
        // Only a text element can be edited, and only one that still exists -
        // the machine cannot know that the draft it asked for was rejected.
        if (element?.type !== 'text') break;
        store.select([id]);
        openTextEditor(id);
        break;
      }
      case 'endTextEdit':
        // Idempotent: the overlay also closes itself on Escape and on blur, and
        // whichever of the two happens second must not clear a *different*
        // state that has since been entered.
        if (store.interaction.kind === 'editing-text') store.setInteraction({ kind: 'idle' });
        break;
      case 'requestImageUpload':
        // Fire-and-forget: the file picker is a dialog the user may take
        // seconds over, and the gesture that asked for it is already finished.
        // Failures reach the UI through `features/images`' error channel, which
        // is why nothing is awaited or caught here.
        void pickImageFiles().then((files) => insertImageFiles(files, intent.worldPoint));
        break;
      default:
        assertNever(intent, 'interaction intent');
    }
  }
}

/* ------------------------------------------------------------- text edit -- */

/**
 * Puts the store into `editing-text`, one microtask late.
 *
 * The interaction state *is* the answer to "who is being edited" - the overlay
 * mounts against it and the renderer already receives it in the scene - so
 * opening a caret needs nothing new stored. The delay is the subtle part.
 *
 * `usePointerInteraction` runs a batch of intents and *then* mirrors the
 * machine's resulting state into the store. Both paths into text editing pass
 * through that mirror, but they resolve to different states:
 *
 *  - double-click resolves to `editing-text`, so the mirror writes exactly what
 *    this function would have written;
 *  - the text tool's `pointerup` resolves to **idle** - the draw gesture really
 *    is over - and `beginTextEdit` rides along in the same batch. A synchronous
 *    write here would be overwritten by that `idle` a few lines later, and the
 *    editor would never appear.
 *
 * Deferring lands the write after the mirror, which is also the truthful
 * ordering: the gesture ends, then the edit begins. The guards below make it a
 * no-op when the mirror already opened the editor, and refuse to steal the
 * interaction back if a new gesture has started in the meantime.
 */
function openTextEditor(id: ElementId): void {
  queueMicrotask(() => {
    const store = useCanvasStore.getState();
    const element = store.elements.byId[id];
    if (element?.type !== 'text') return;

    const current = store.interaction;
    if (current.kind === 'editing-text') return;
    if (current.kind !== 'idle') return;

    store.setInteraction({ kind: 'editing-text', elementId: id });
  });
}

/* ------------------------------------------------------------------ draft -- */

function buildDraft(
  draft: DraftGeometry,
  existing: readonly CanvasElement[],
  style: ElementStyle
): CanvasElement {
  const span = rectFromPoints(draft.startWorld, draft.endWorld);
  const box = worldRect(span.x, span.y, span.width, span.height);
  const options = { style, existing };

  switch (draft.tool) {
    case 'rectangle':
      return createRectangle(box, options);
    case 'ellipse':
      return createEllipse(box, options);
    case 'line':
      return createLine(draft.startWorld, draft.endWorld, options);
    case 'arrow':
      return createArrow(draft.startWorld, draft.endWorld, options);
    case 'text':
      return createText(box, options);
    case 'freehand':
      return createFreehand(draft.points, options);
    default:
      return assertNever(draft.tool, 'drawing tool');
  }
}

/** The fields a draw drag changes. Everything else on the draft stays as created. */
function geometryPatch(element: CanvasElement): ElementPatch {
  const box = { x: element.x, y: element.y, width: element.width, height: element.height };
  switch (element.type) {
    case 'line':
    case 'arrow':
      return { ...box, start: element.start, end: element.end };
    case 'freehand':
      return { ...box, points: element.points };
    // `group` is unreachable here - a draw drag never produces one - but the box
    // is still the honest patch for it, since geometry is all a group has. It
    // sits with the plain-box variants because that is what it is, not because
    // the switch needed filling in.
    case 'rectangle':
    case 'ellipse':
    case 'text':
    case 'image':
    case 'group':
      return box;
    default:
      return assertNever(element, 'element type');
  }
}