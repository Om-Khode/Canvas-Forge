/**
 * The pointer state machine.
 *
 * A pure reducer: `(state, event, context) => { state, intents }`. It reads
 * nothing and writes nothing - the store, the DOM, and the element factories are
 * all on the far side of `usePointerInteraction`, which executes the intents.
 *
 * The split is what makes this testable. Every transition in
 * docs/architecture.md §10 can be driven from a literal object with no canvas,
 * no jsdom, and no store, which is the difference between "the drag threshold is
 * probably 3px" and a test that says so.
 *
 * Two conventions the adapter depends on:
 *
 *  1. **Transform intents carry the total delta from the gesture origin**, never
 *     an increment. The adapter snapshots the affected elements when it sees
 *     `beginTransaction` and re-applies each intent against that snapshot, so a
 *     200-move drag is 200 absolute placements rather than 200 accumulated
 *     additions - no compounding float drift, and an aborted gesture leaves no
 *     residue. `features/elements/operations` is built for exactly this shape.
 *  2. **The draft element's id belongs to the adapter.** The machine owns the
 *     draft's *geometry* and says when to create, update, and commit it; it
 *     cannot know an id that `createId()` mints on the other side of the wall.
 */

import { CLICK_TO_PLACE_THRESHOLD, DEFAULT_SHAPE_SIZE, DRAG_THRESHOLD_PX } from '@/constants';
import {
  assertNever,
  type DrawingToolId,
  type InteractionState,
  type ToolId,
  type WorldPoint,
  type WorldRect,
  type WorldVector,
} from '@/types';
import type {
  DraftGeometry,
  InteractionContext,
  InteractionEvent,
  InteractionIntent,
  InteractionResult,
  PointerButton,
} from '@/features/canvas/interaction/protocol';
import { worldPoint, worldRect, worldVector } from '@/utils/coords';
import { rectFromPoints } from '@/utils/geometry';

/*
 * The event, context, intent and result vocabulary lives in `protocol.ts`, and
 * is re-exported here so callers have one import site for "the machine".
 */
export * from '@/features/canvas/interaction/protocol';


/* ---------------------------------------------------------------- tables -- */

const DRAW_LABELS: Readonly<Record<DrawingToolId, string>> = {
  rectangle: 'Draw rectangle',
  ellipse: 'Draw ellipse',
  line: 'Draw line',
  arrow: 'Draw arrow',
  freehand: 'Draw path',
  text: 'Add text',
};

/** Tools whose sub-threshold drag becomes a default-sized shape instead of a speck. */
const CLICK_TO_PLACE_TOOLS: ReadonlySet<DrawingToolId> = new Set<DrawingToolId>([
  'rectangle',
  'ellipse',
  'line',
  'arrow',
]);

const IDLE: InteractionState = { kind: 'idle' };

/**
 * The one runtime answer to "does this tool create an element by dragging?".
 * `DrawingToolId` is compile-time only, so the guard is derived from the label
 * table - a new drawing tool needs a label anyway, and deriving it here means it
 * cannot be added to one list and forgotten in the other.
 */
export function isDrawingTool(tool: ToolId): tool is DrawingToolId {
  return Object.hasOwn(DRAW_LABELS, tool);
}

function done(...intents: InteractionIntent[]): InteractionResult {
  return { state: IDLE, intents };
}

function stay(state: InteractionState, ...intents: InteractionIntent[]): InteractionResult {
  return { state, intents };
}

function angleTo(center: WorldPoint, point: WorldPoint): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}

function spanRect(a: WorldPoint, b: WorldPoint): WorldRect {
  const rect = rectFromPoints(a, b);
  return worldRect(rect.x, rect.y, rect.width, rect.height);
}

/* ------------------------------------------------------------- transitions -- */

export function reduce(
  state: InteractionState,
  event: InteractionEvent,
  context: InteractionContext
): InteractionResult {
  // Escape and cancel mean the same thing from every state, so they are handled
  // once here rather than as a branch inside each of the nine handlers.
  if (event.kind === 'cancel') return abort(state);
  if (event.kind === 'keydown') return event.key === 'Escape' ? abort(state) : stay(state);
  if (event.kind === 'doubleclick') return onDoubleClick(state, context);

  switch (state.kind) {
    case 'idle':
      return event.kind === 'pointerdown' ? onIdlePointerDown(event.button, context) : stay(state);

    case 'pending-drag':
      if (event.kind === 'pointermove') return onPendingMove(state, context);
      // A press that never passed the threshold is a click. The selection was
      // only touched at pointerdown if the target was not already selected, so
      // re-asserting it here collapses a multi-selection to the clicked element
      // and is a no-op otherwise (the slice compares membership).
      if (event.kind === 'pointerup') {
        return state.additive ? done() : done({ kind: 'select', ids: [state.targetId] });
      }
      return stay(state);

    case 'dragging':
      if (event.kind === 'pointermove') return onDragMove(state, context);
      if (event.kind === 'pointerup') return done({ kind: 'commitTransaction' });
      return stay(state);

    case 'resizing':
      if (event.kind === 'pointermove') return onResizeMove(state, context);
      if (event.kind === 'pointerup') return done({ kind: 'commitTransaction' });
      return stay(state);

    case 'rotating':
      if (event.kind === 'pointermove') return onRotateMove(state, context);
      if (event.kind === 'pointerup') return done({ kind: 'commitTransaction' });
      return stay(state);

    case 'marquee':
      if (event.kind === 'pointermove' || event.kind === 'pointerup') {
        const next: InteractionState = { ...state, currentWorld: context.worldPoint };
        const pick: InteractionIntent = {
          kind: 'marqueeSelect',
          rectWorld: spanRect(state.originWorld, context.worldPoint),
          additive: state.additive,
        };
        return event.kind === 'pointerup' ? done(pick) : stay(next, pick);
      }
      return stay(state);

    case 'drawing':
      if (event.kind === 'pointermove') return onDrawMove(state, context);
      if (event.kind === 'pointerup') return onDrawUp(state, context);
      return stay(state);

    case 'panning':
      if (event.kind === 'pointermove') {
        return stay(state, {
          kind: 'panTo',
          // Absolute from the gesture's origin pan, not `panBy(dx, dy)` per move:
          // an increment that arrives while a zoom is in flight lands against a
          // different transform and the canvas slips under the cursor.
          panX: state.originPanX + (context.screenPoint.x - state.originScreenX),
          panY: state.originPanY + (context.screenPoint.y - state.originScreenY),
        });
      }
      return event.kind === 'pointerup' ? done() : stay(state);

    case 'editing-text':
      // A press anywhere ends the edit. The overlay that owns the caret is a
      // later phase; until then this state is only reachable by double-click.
      return event.kind === 'pointerdown' ? done({ kind: 'endTextEdit' }) : stay(state);

    default:
      return assertNever(state, 'interaction state');
  }
}

/* ------------------------------------------------------------------- idle -- */

function onIdlePointerDown(button: PointerButton, context: InteractionContext): InteractionResult {
  const { modifiers, tool, hit, viewport } = context;
  const point = context.worldPoint;

  // Right-click belongs to the context menu, not to any gesture.
  if (button === 'secondary') return stay(IDLE);

  // Three ways to ask for the same thing: the hand tool, space-drag, and
  // middle-drag. None of them touches the document, so none opens a transaction.
  if (button === 'middle' || modifiers.space || tool === 'hand') {
    return stay({
      kind: 'panning',
      originScreenX: context.screenPoint.x,
      originScreenY: context.screenPoint.y,
      originPanX: viewport.panX,
      originPanY: viewport.panY,
    });
  }

  // The image tool needs a file before it can create anything, so the gesture
  // ends here and the adapter opens a picker.
  if (tool === 'image') return done({ kind: 'requestImageUpload', worldPoint: point });

  if (isDrawingTool(tool)) {
    const draft: DraftGeometry = {
      tool,
      startWorld: point,
      endWorld: point,
      points: [point],
    };
    return stay(
      { kind: 'drawing', tool, originWorld: point, currentWorld: point, points: [point] },
      { kind: 'clearSelection' },
      { kind: 'beginTransaction', label: DRAW_LABELS[tool] },
      { kind: 'createDraft', draft }
    );
  }

  if (hit.kind === 'handle') {
    /*
      A locked selection has no handles drawn, but the geometry that decides
      *where* a handle would be does not know about locking - so a press at
      those coordinates would still open a resize. Refusing here keeps the
      guard next to the transition it blocks, rather than relying on the
      overlay having declined to paint something.
    */
    if (context.selectionLocked) return stay(IDLE);

    if (hit.handle === 'rotate') {
      const center = context.selectionCenterWorld;
      // Unreachable in practice - no selection means no handles to hit - but a
      // rotation about a null pivot would produce NaN geometry, so it is refused
      // rather than asserted away.
      if (center === null) return stay(IDLE);
      const angle = angleTo(center, point);
      return stay(
        {
          kind: 'rotating',
          centerWorld: center,
          startAngle: angle,
          currentAngle: angle,
          snapped: modifiers.shift,
        },
        { kind: 'beginTransaction', label: 'Rotate elements' }
      );
    }
    return stay(
      {
        kind: 'resizing',
        handle: hit.handle,
        originWorld: point,
        currentWorld: point,
        preserveAspect: modifiers.shift || context.lockAspect,
        fromCenter: modifiers.alt,
      },
      { kind: 'beginTransaction', label: 'Resize elements' }
    );
  }

  if (hit.kind === 'element') {
    // Selection is settled *now* only when it has to be: a press on something
    // outside the selection must select it before the drag can move the right
    // thing. A press on something already selected defers to pointerup, so that
    // dragging one member of a multi-selection moves all of them rather than
    // collapsing to the one under the cursor.
    const intents: InteractionIntent[] = [];
    // Membership is tested against `selectId` - what a click here resolves to -
    // not against the leaf under the cursor. Pressing a member of an
    // already-selected group must be treated as pressing the selection, or
    // dragging a group would collapse it to the one member that got hit.
    if (modifiers.shift) intents.push({ kind: 'toggleSelect', id: hit.id });
    else if (!context.selection.has(hit.selectId)) intents.push({ kind: 'select', ids: [hit.id] });

    return stay(
      { kind: 'pending-drag', originWorld: point, targetId: hit.id, additive: modifiers.shift },
      ...intents
    );
  }

  return stay(
    {
      kind: 'marquee',
      originWorld: point,
      currentWorld: point,
      additive: modifiers.shift,
    },
    // Pressing empty canvas is how you leave a group, the same gesture every
    // design tool uses - but only a *plain* press. Shift is additive
    // everywhere else this machine sees it (toggleSelect, the marquee's
    // `additive` flag): it never destroys something that was true a moment
    // ago. Exiting the group on a shift-press would break that pattern for no
    // reason the modifier asked for, so a shift-press starts an additive
    // marquee at the current level instead of leaving it. The other two exits
    // are Escape (owned by the shortcut registry, which already claims that
    // key at idle) and loading a project.
    ...(context.enteredGroupId === null || modifiers.shift
      ? []
      : [{ kind: 'enterGroup', groupId: null } as InteractionIntent])
  );
}

function onDoubleClick(state: InteractionState, context: InteractionContext): InteractionResult {
  const { hit } = context;
  if (state.kind !== 'idle' || hit.kind !== 'element') return stay(state);

  // Descending takes precedence over editing: a text element inside a group is
  // reached by double-clicking into the group first, and only once it is
  // directly selectable does the second double-click open the caret. Both
  // intents carry the *leaf* id - the executor resolves it against the group
  // that was just entered, which is what lands the selection one level down.
  if (hit.enterGroupId !== null) {
    return stay(
      IDLE,
      { kind: 'enterGroup', groupId: hit.enterGroupId },
      { kind: 'select', ids: [hit.id] }
    );
  }

  if (hit.type !== 'text') return stay(state);
  return stay(
    { kind: 'editing-text', elementId: hit.id },
    {
      kind: 'beginTextEdit',
      elementId: hit.id,
    }
  );
}

/* ---------------------------------------------------------------- dragging -- */

function onPendingMove(
  state: Extract<InteractionState, { kind: 'pending-drag' }>,
  context: InteractionContext
): InteractionResult {
  const dx = context.worldPoint.x - state.originWorld.x;
  const dy = context.worldPoint.y - state.originWorld.y;

  // The threshold is a *screen* distance - 3px of hand tremor is 3px whether you
  // are at 10% or 1600% zoom. `pending-drag` only carries the world origin
  // (the state union is a frozen shared contract), so the world distance is
  // scaled back up by the zoom rather than kept alongside in screen units.
  if (Math.hypot(dx, dy) * context.viewport.zoom < DRAG_THRESHOLD_PX) return stay(state);

  return stay(
    { kind: 'dragging', originWorld: state.originWorld, currentWorld: context.worldPoint },
    { kind: 'beginTransaction', label: 'Move elements' },
    { kind: 'translate', deltaWorld: constrain(dx, dy, context.modifiers.shift) }
  );
}

function onDragMove(
  state: Extract<InteractionState, { kind: 'dragging' }>,
  context: InteractionContext
): InteractionResult {
  const dx = context.worldPoint.x - state.originWorld.x;
  const dy = context.worldPoint.y - state.originWorld.y;
  return stay(
    { ...state, currentWorld: context.worldPoint },
    {
      kind: 'translate',
      deltaWorld: constrain(dx, dy, context.modifiers.shift),
    }
  );
}

/** Shift locks a drag to the dominant axis - the standard straight-line escape. */
function constrain(dx: number, dy: number, shift: boolean): WorldVector {
  if (!shift) return worldVector(dx, dy);
  return Math.abs(dx) >= Math.abs(dy) ? worldVector(dx, 0) : worldVector(0, dy);
}

/* -------------------------------------------------------- resize / rotate -- */

function onResizeMove(
  state: Extract<InteractionState, { kind: 'resizing' }>,
  context: InteractionContext
): InteractionResult {
  const preserveAspect = context.modifiers.shift || context.lockAspect;
  const fromCenter = context.modifiers.alt;
  return stay(
    { ...state, currentWorld: context.worldPoint, preserveAspect, fromCenter },
    {
      kind: 'resize',
      handle: state.handle,
      pointerWorld: context.worldPoint,
      preserveAspect,
      fromCenter,
    }
  );
}

function onRotateMove(
  state: Extract<InteractionState, { kind: 'rotating' }>,
  context: InteractionContext
): InteractionResult {
  const currentAngle = angleTo(state.centerWorld, context.worldPoint);
  const snapped = context.modifiers.shift;
  return stay(
    { ...state, currentAngle, snapped },
    {
      kind: 'rotate',
      centerWorld: state.centerWorld,
      // The *delta* since the gesture started. Snapping the delta rather than each
      // element's absolute angle keeps a deliberately-splayed group splayed.
      radians: currentAngle - state.startAngle,
      snap: snapped,
    }
  );
}

/* ---------------------------------------------------------------- drawing -- */

function onDrawMove(
  state: Extract<InteractionState, { kind: 'drawing' }>,
  context: InteractionContext
): InteractionResult {
  // Only freehand accumulates samples. Appending for the other tools would grow
  // an array of thousands of points that nothing ever reads.
  const points =
    state.tool === 'freehand'
      ? [...state.points, context.worldPoint]
      : [state.originWorld, context.worldPoint];

  const next: InteractionState = { ...state, currentWorld: context.worldPoint, points };
  return stay(next, {
    kind: 'updateDraft',
    draft: {
      tool: state.tool,
      startWorld: state.originWorld,
      endWorld: context.worldPoint,
      points,
    },
  });
}

function onDrawUp(
  state: Extract<InteractionState, { kind: 'drawing' }>,
  context: InteractionContext
): InteractionResult {
  const endWorld = clickToPlace(state, context);
  const points = state.tool === 'freehand' ? state.points : [state.originWorld, endWorld];

  const intents: InteractionIntent[] = [
    {
      kind: 'updateDraft',
      draft: { tool: state.tool, startWorld: state.originWorld, endWorld, points },
    },
    { kind: 'commitDraft' },
    { kind: 'commitTransaction' },
  ];

  // The text overlay lands in a later phase; the intent is emitted now so the
  // seam exists and the adapter has one place to grow a caret into.
  if (state.tool === 'text') intents.push({ kind: 'beginTextEdit', elementId: null });

  return done(...intents);
}

/**
 * A click with a draw tool should place a usable shape, not a 1px speck the user
 * then has to hunt for. Below the threshold the drag is reinterpreted as a
 * default-sized box with the click as its top-left corner - the same convention
 * as dragging one out, so the two gestures produce shapes in the same place.
 *
 * Text and freehand are excluded: a text box grows from its content and an empty
 * freehand stroke is not a shape anyone meant to make.
 */
function clickToPlace(
  state: Extract<InteractionState, { kind: 'drawing' }>,
  context: InteractionContext
): WorldPoint {
  if (!CLICK_TO_PLACE_TOOLS.has(state.tool)) return context.worldPoint;

  const dx = context.worldPoint.x - state.originWorld.x;
  const dy = context.worldPoint.y - state.originWorld.y;
  if (Math.hypot(dx, dy) * context.viewport.zoom >= CLICK_TO_PLACE_THRESHOLD) {
    return context.worldPoint;
  }
  return worldPoint(
    state.originWorld.x + DEFAULT_SHAPE_SIZE,
    state.originWorld.y + DEFAULT_SHAPE_SIZE
  );
}

/* ------------------------------------------------------------------ abort -- */

/**
 * Escape, pointercancel, and lost capture all mean "undo whatever this gesture
 * did and go back to idle". Only states that opened a transaction roll one back;
 * emitting `abortTransaction` from a state that never began one would close
 * somebody else's.
 */
function abort(state: InteractionState): InteractionResult {
  switch (state.kind) {
    case 'dragging':
    case 'resizing':
    case 'rotating':
    case 'drawing':
      return done({ kind: 'abortTransaction' });

    case 'marquee':
      // Selection is not in history, so there is no snapshot to restore - and
      // `InteractionState['marquee']` (a frozen contract) has no slot to stash
      // the pre-marquee selection in. Clearing is the least surprising of the
      // options actually available: an abandoned marquee selects nothing.
      return done({ kind: 'clearSelection' });

    case 'panning':
      return done({ kind: 'panTo', panX: state.originPanX, panY: state.originPanY });

    case 'editing-text':
      return done({ kind: 'endTextEdit' });

    case 'idle':
    case 'pending-drag':
      return done();

    default:
      return assertNever(state, 'interaction state');
  }
}
