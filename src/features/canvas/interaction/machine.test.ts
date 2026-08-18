import { describe, expect, it } from 'vitest';
import { CLICK_TO_PLACE_THRESHOLD, DEFAULT_SHAPE_SIZE, DRAG_THRESHOLD_PX } from '@/constants';
import type { ElementId, InteractionState, ToolId, Viewport } from '@/types';
import { screenPoint, worldPoint } from '@/utils/coords';
import {
  isDrawingTool,
  reduce,
  type InteractionContext,
  type InteractionEvent,
  type InteractionHit,
  type InteractionIntent,
  type Modifiers,
} from './machine';

/* ------------------------------------------------------------------ setup -- */

const NO_MODIFIERS: Modifiers = { shift: false, alt: false, mod: false, space: false };
const UNIT_VIEWPORT: Viewport = { panX: 0, panY: 0, zoom: 1 };

interface ContextOverrides {
  readonly world?: readonly [number, number];
  readonly screen?: readonly [number, number];
  readonly modifiers?: Partial<Modifiers>;
  readonly tool?: ToolId;
  readonly hit?: InteractionHit;
  readonly selection?: readonly ElementId[];
  readonly viewport?: Viewport;
  readonly center?: readonly [number, number] | null;
  readonly lockAspect?: boolean;
  readonly selectionLocked?: boolean;
  readonly enteredGroupId?: ElementId | null;
}

function ctx(overrides: ContextOverrides = {}): InteractionContext {
  const [wx, wy] = overrides.world ?? [0, 0];
  const [sx, sy] = overrides.screen ?? [wx, wy];
  const center = overrides.center;
  return {
    worldPoint: worldPoint(wx, wy),
    screenPoint: screenPoint(sx, sy),
    modifiers: { ...NO_MODIFIERS, ...overrides.modifiers },
    lockAspect: overrides.lockAspect ?? false,
    selectionLocked: overrides.selectionLocked ?? false,
    enteredGroupId: overrides.enteredGroupId ?? null,
    tool: overrides.tool ?? 'select',
    hit: overrides.hit ?? { kind: 'none' },
    selection: new Set(overrides.selection ?? []),
    viewport: overrides.viewport ?? UNIT_VIEWPORT,
    selectionCenterWorld:
      center === undefined || center === null ? null : worldPoint(center[0], center[1]),
  };
}

const DOWN: InteractionEvent = { kind: 'pointerdown', button: 'primary' };
const MOVE: InteractionEvent = { kind: 'pointermove' };
const UP: InteractionEvent = { kind: 'pointerup' };
const ESCAPE: InteractionEvent = { kind: 'keydown', key: 'Escape' };
const CANCEL: InteractionEvent = { kind: 'cancel' };

const IDLE: InteractionState = { kind: 'idle' };

/* A loose element: a click selects it and there is nothing to descend into. */
const onElement: InteractionHit = {
  kind: 'element',
  id: 'a',
  type: 'rectangle',
  selectId: 'a',
  enterGroupId: null,
};
const onText: InteractionHit = {
  kind: 'element',
  id: 't',
  type: 'text',
  selectId: 't',
  enterGroupId: null,
};
/* The same leaf, but inside group `g` - what the adapter reports for a member. */
const onGrouped: InteractionHit = {
  kind: 'element',
  id: 'a',
  type: 'rectangle',
  selectId: 'g',
  enterGroupId: 'g',
};

function kinds(intents: readonly InteractionIntent[]): string[] {
  return intents.map((intent) => intent.kind);
}

function find<K extends InteractionIntent['kind']>(
  intents: readonly InteractionIntent[],
  kind: K
): Extract<InteractionIntent, { kind: K }> {
  const found = intents.find((intent) => intent.kind === kind);
  if (found === undefined)
    throw new Error(`expected a "${kind}" intent, got ${kinds(intents).join(', ')}`);
  return found as Extract<InteractionIntent, { kind: K }>;
}

/* ------------------------------------------------------- idle → everything -- */

describe('idle pointerdown', () => {
  it('starts a marquee on empty canvas', () => {
    const { state, intents } = reduce(IDLE, DOWN, ctx({ world: [10, 20] }));
    expect(state).toMatchObject({ kind: 'marquee', additive: false });
    // Nothing has been selected or deselected yet - a click that turns out to be
    // a zero-area marquee clears the selection on pointerup instead.
    expect(intents).toEqual([]);
  });

  it('marks the marquee additive when shift is held', () => {
    const { state } = reduce(
      IDLE,
      DOWN,
      ctx({ hit: { kind: 'none' }, modifiers: { shift: true } })
    );
    expect(state).toMatchObject({ kind: 'marquee', additive: true });
  });

  it('selects an unselected element before entering pending-drag', () => {
    const { state, intents } = reduce(IDLE, DOWN, ctx({ hit: onElement }));
    expect(state).toMatchObject({ kind: 'pending-drag', targetId: 'a', additive: false });
    expect(intents).toEqual([{ kind: 'select', ids: ['a'] }]);
  });

  it('leaves a multi-selection alone when pressing a member of it', () => {
    const { state, intents } = reduce(IDLE, DOWN, ctx({ hit: onElement, selection: ['a', 'b'] }));
    // Deferred to pointerup, so that dragging one member moves all of them.
    expect(state.kind).toBe('pending-drag');
    expect(intents).toEqual([]);
  });

  it('toggles membership on shift-click', () => {
    const { intents } = reduce(
      IDLE,
      DOWN,
      ctx({ hit: onElement, selection: ['a'], modifiers: { shift: true } })
    );
    expect(intents).toEqual([{ kind: 'toggleSelect', id: 'a' }]);
  });

  it('enters resizing from a resize handle and opens exactly one transaction', () => {
    const { state, intents } = reduce(
      IDLE,
      DOWN,
      ctx({ hit: { kind: 'handle', handle: 'se' }, modifiers: { shift: true, alt: true } })
    );
    expect(state).toMatchObject({
      kind: 'resizing',
      handle: 'se',
      preserveAspect: true,
      fromCenter: true,
    });
    expect(intents).toEqual([{ kind: 'beginTransaction', label: 'Resize elements' }]);
  });

  it('enters rotating from the rotate handle with the pivot as centre', () => {
    const { state, intents } = reduce(
      IDLE,
      DOWN,
      ctx({ hit: { kind: 'handle', handle: 'rotate' }, world: [10, 0], center: [0, 0] })
    );
    expect(state).toMatchObject({ kind: 'rotating', startAngle: 0, currentAngle: 0 });
    expect(kinds(intents)).toEqual(['beginTransaction']);
  });

  it('refuses to rotate about a null pivot', () => {
    const { state, intents } = reduce(
      IDLE,
      DOWN,
      ctx({ hit: { kind: 'handle', handle: 'rotate' }, center: null })
    );
    expect(state).toEqual(IDLE);
    expect(intents).toEqual([]);
  });

  it('starts a draw with a cleared selection, a transaction, and a draft', () => {
    const { state, intents } = reduce(IDLE, DOWN, ctx({ tool: 'ellipse', world: [5, 5] }));
    expect(state).toMatchObject({ kind: 'drawing', tool: 'ellipse' });
    expect(kinds(intents)).toEqual(['clearSelection', 'beginTransaction', 'createDraft']);
    expect(find(intents, 'beginTransaction').label).toBe('Draw ellipse');
  });

  it.each<ToolId>(['rectangle', 'ellipse', 'line', 'arrow', 'freehand', 'text'])(
    'treats %s as a drawing tool',
    (tool) => {
      expect(isDrawingTool(tool)).toBe(true);
      expect(reduce(IDLE, DOWN, ctx({ tool })).state.kind).toBe('drawing');
    }
  );

  it('pans for the hand tool, for space, and for the middle button - without a transaction', () => {
    const viewport: Viewport = { panX: 7, panY: 9, zoom: 2 };
    const expected = {
      kind: 'panning',
      originScreenX: 3,
      originScreenY: 4,
      originPanX: 7,
      originPanY: 9,
    };

    for (const context of [
      ctx({ tool: 'hand', screen: [3, 4], viewport }),
      ctx({ modifiers: { space: true }, screen: [3, 4], viewport }),
    ]) {
      const { state, intents } = reduce(IDLE, DOWN, context);
      expect(state).toMatchObject(expected);
      expect(intents).toEqual([]);
    }

    const middle = reduce(
      IDLE,
      { kind: 'pointerdown', button: 'middle' },
      ctx({ hit: onElement, screen: [3, 4], viewport })
    );
    expect(middle.state).toMatchObject(expected);
  });

  it('ignores the secondary button', () => {
    const result = reduce(
      IDLE,
      { kind: 'pointerdown', button: 'secondary' },
      ctx({ hit: onElement })
    );
    expect(result.state).toEqual(IDLE);
    expect(result.intents).toEqual([]);
  });

  it('asks for a file rather than drawing with the image tool', () => {
    const { state, intents } = reduce(IDLE, DOWN, ctx({ tool: 'image', world: [4, 8] }));
    expect(state.kind).toBe('idle');
    expect(find(intents, 'requestImageUpload').worldPoint).toEqual({ x: 4, y: 8 });
  });
});

/* -------------------------------------------------------------- drag threshold -- */

describe('pending-drag', () => {
  const pending: InteractionState = {
    kind: 'pending-drag',
    originWorld: worldPoint(0, 0),
    targetId: 'a',
    additive: false,
  };

  it('does not become a drag below the threshold', () => {
    const justUnder = (DRAG_THRESHOLD_PX - 0.5) / 1;
    const result = reduce(pending, MOVE, ctx({ world: [justUnder, 0] }));
    expect(result.state).toBe(pending);
    expect(result.intents).toEqual([]);
  });

  it('becomes a drag past the threshold, opening the transaction then', () => {
    const { state, intents } = reduce(pending, MOVE, ctx({ world: [DRAG_THRESHOLD_PX + 1, 0] }));
    expect(state.kind).toBe('dragging');
    expect(kinds(intents)).toEqual(['beginTransaction', 'translate']);
    expect(find(intents, 'beginTransaction').label).toBe('Move elements');
  });

  it('measures the threshold in screen pixels, not world units', () => {
    // The same world displacement is a sub-threshold nudge when zoomed out and a
    // real drag when zoomed in. Measuring in world units would make the editor
    // impossible to click at 800% and impossible to drag at 5%.
    const world: readonly [number, number] = [DRAG_THRESHOLD_PX + 1, 0];
    const zoomedOut = reduce(
      pending,
      MOVE,
      ctx({ world, viewport: { panX: 0, panY: 0, zoom: 0.1 } })
    );
    const zoomedIn = reduce(
      pending,
      MOVE,
      ctx({ world, viewport: { panX: 0, panY: 0, zoom: 10 } })
    );
    expect(zoomedOut.state.kind).toBe('pending-drag');
    expect(zoomedIn.state.kind).toBe('dragging');
  });

  it('is a click-select on pointerup, collapsing a multi-selection', () => {
    const { state, intents } = reduce(pending, UP, ctx({ selection: ['a', 'b'] }));
    expect(state.kind).toBe('idle');
    expect(intents).toEqual([{ kind: 'select', ids: ['a'] }]);
  });

  it('leaves the selection alone on an additive click, which pointerdown already toggled', () => {
    const { intents } = reduce({ ...pending, additive: true }, UP, ctx());
    expect(intents).toEqual([]);
  });

  it('has no transaction to abort on Escape', () => {
    const { state, intents } = reduce(pending, ESCAPE, ctx());
    expect(state.kind).toBe('idle');
    expect(intents).toEqual([]);
  });
});

/* ------------------------------------------------------------------- drag -- */

describe('dragging', () => {
  const dragging: InteractionState = {
    kind: 'dragging',
    originWorld: worldPoint(10, 10),
    currentWorld: worldPoint(12, 12),
  };

  it('emits the total delta from the origin, never an increment', () => {
    const { intents } = reduce(dragging, MOVE, ctx({ world: [40, 30] }));
    expect(find(intents, 'translate').deltaWorld).toEqual({ x: 30, y: 20 });
  });

  it('never re-opens the transaction while moving', () => {
    const { intents } = reduce(dragging, MOVE, ctx({ world: [40, 30] }));
    expect(kinds(intents)).toEqual(['translate']);
  });

  it('locks to the dominant axis with shift', () => {
    const horizontal = reduce(dragging, MOVE, ctx({ world: [40, 12], modifiers: { shift: true } }));
    expect(find(horizontal.intents, 'translate').deltaWorld).toEqual({ x: 30, y: 0 });

    const vertical = reduce(dragging, MOVE, ctx({ world: [11, 90], modifiers: { shift: true } }));
    expect(find(vertical.intents, 'translate').deltaWorld).toEqual({ x: 0, y: 80 });
  });

  it('commits on pointerup', () => {
    const { state, intents } = reduce(dragging, UP, ctx());
    expect(state.kind).toBe('idle');
    expect(intents).toEqual([{ kind: 'commitTransaction' }]);
  });

  it('aborts on Escape and on cancel', () => {
    for (const event of [ESCAPE, CANCEL]) {
      const { state, intents } = reduce(dragging, event, ctx());
      expect(state.kind).toBe('idle');
      expect(intents).toEqual([{ kind: 'abortTransaction' }]);
    }
  });
});

/* --------------------------------------------------------- resize / rotate -- */

describe('resizing', () => {
  const resizing: InteractionState = {
    kind: 'resizing',
    handle: 'nw',
    originWorld: worldPoint(0, 0),
    currentWorld: worldPoint(0, 0),
    preserveAspect: false,
    fromCenter: false,
  };

  it('passes the live pointer and the live modifiers through', () => {
    const { state, intents } = reduce(
      resizing,
      MOVE,
      ctx({ world: [-5, -5], modifiers: { shift: true, alt: true } })
    );
    expect(state).toMatchObject({ preserveAspect: true, fromCenter: true });
    expect(find(intents, 'resize')).toEqual({
      kind: 'resize',
      handle: 'nw',
      pointerWorld: { x: -5, y: -5 },
      preserveAspect: true,
      fromCenter: true,
    });
  });

  it('commits on up and aborts on Escape', () => {
    expect(reduce(resizing, UP, ctx()).intents).toEqual([{ kind: 'commitTransaction' }]);
    expect(reduce(resizing, ESCAPE, ctx()).intents).toEqual([{ kind: 'abortTransaction' }]);
  });
});

describe('rotating', () => {
  const rotating: InteractionState = {
    kind: 'rotating',
    centerWorld: worldPoint(0, 0),
    startAngle: 0,
    currentAngle: 0,
    snapped: false,
  };

  it('emits the delta since the gesture began, not the absolute angle', () => {
    const quarterTurn = reduce(rotating, MOVE, ctx({ world: [0, 10] }));
    expect(find(quarterTurn.intents, 'rotate').radians).toBeCloseTo(Math.PI / 2);

    const fromAnEighth: InteractionState = { ...rotating, startAngle: Math.PI / 4 };
    const result = reduce(fromAnEighth, MOVE, ctx({ world: [0, 10] }));
    expect(find(result.intents, 'rotate').radians).toBeCloseTo(Math.PI / 4);
  });

  it('snaps only while shift is held', () => {
    expect(find(reduce(rotating, MOVE, ctx({ world: [0, 10] })).intents, 'rotate').snap).toBe(
      false
    );
    const snapped = reduce(rotating, MOVE, ctx({ world: [0, 10], modifiers: { shift: true } }));
    expect(find(snapped.intents, 'rotate').snap).toBe(true);
    expect(snapped.state).toMatchObject({ snapped: true });
  });

  it('commits on up and aborts on cancel', () => {
    expect(reduce(rotating, UP, ctx()).intents).toEqual([{ kind: 'commitTransaction' }]);
    expect(reduce(rotating, CANCEL, ctx()).intents).toEqual([{ kind: 'abortTransaction' }]);
  });
});

/* ---------------------------------------------------------------- marquee -- */

describe('marquee', () => {
  const marquee: InteractionState = {
    kind: 'marquee',
    originWorld: worldPoint(10, 10),
    currentWorld: worldPoint(10, 10),
    additive: false,
  };

  it('selects live, with the rect normalized for a backwards drag', () => {
    const { state, intents } = reduce(marquee, MOVE, ctx({ world: [4, 2] }));
    expect(state).toMatchObject({ kind: 'marquee', currentWorld: { x: 4, y: 2 } });
    expect(find(intents, 'marqueeSelect').rectWorld).toEqual({ x: 4, y: 2, width: 6, height: 8 });
  });

  it('carries the additive flag through to the selection', () => {
    const { intents } = reduce({ ...marquee, additive: true }, MOVE, ctx({ world: [20, 20] }));
    expect(find(intents, 'marqueeSelect').additive).toBe(true);
  });

  it('finishes on pointerup; a zero-area rect is how a click on empty space clears', () => {
    const { state, intents } = reduce(marquee, UP, ctx({ world: [10, 10] }));
    expect(state.kind).toBe('idle');
    expect(find(intents, 'marqueeSelect').rectWorld).toEqual({ x: 10, y: 10, width: 0, height: 0 });
  });

  it('clears rather than rolls back on Escape - selection is not in history', () => {
    const { state, intents } = reduce(marquee, ESCAPE, ctx());
    expect(state.kind).toBe('idle');
    expect(intents).toEqual([{ kind: 'clearSelection' }]);
  });
});

/* ---------------------------------------------------------------- drawing -- */

describe('drawing', () => {
  function drawing(tool: 'rectangle' | 'freehand' | 'text'): InteractionState {
    return {
      kind: 'drawing',
      tool,
      originWorld: worldPoint(0, 0),
      currentWorld: worldPoint(0, 0),
      points: [worldPoint(0, 0)],
    };
  }

  it('accumulates samples for freehand only', () => {
    const stroke = reduce(drawing('freehand'), MOVE, ctx({ world: [5, 5] }));
    expect(find(stroke.intents, 'updateDraft').draft.points).toHaveLength(2);

    const box = reduce(drawing('rectangle'), MOVE, ctx({ world: [5, 5] }));
    // Two corners, not a growing trail of every position the pointer passed.
    expect(find(box.intents, 'updateDraft').draft.points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
  });

  it('commits the draft and the transaction on pointerup', () => {
    const { state, intents } = reduce(drawing('rectangle'), UP, ctx({ world: [200, 200] }));
    expect(state.kind).toBe('idle');
    expect(kinds(intents)).toEqual(['updateDraft', 'commitDraft', 'commitTransaction']);
    expect(find(intents, 'updateDraft').draft.endWorld).toEqual({ x: 200, y: 200 });
  });

  it('turns a click into a default-sized shape rather than a speck', () => {
    const nudge = (CLICK_TO_PLACE_THRESHOLD - 1) / 2;
    const { intents } = reduce(drawing('rectangle'), UP, ctx({ world: [nudge, nudge] }));
    expect(find(intents, 'updateDraft').draft.endWorld).toEqual({
      x: DEFAULT_SHAPE_SIZE,
      y: DEFAULT_SHAPE_SIZE,
    });
  });

  it('leaves a text click at its drawn size and asks for the caret', () => {
    const { intents } = reduce(drawing('text'), UP, ctx({ world: [1, 1] }));
    expect(find(intents, 'updateDraft').draft.endWorld).toEqual({ x: 1, y: 1 });
    expect(find(intents, 'beginTextEdit').elementId).toBeNull();
  });

  it('rolls the draft back out of existence on Escape', () => {
    const { state, intents } = reduce(drawing('rectangle'), ESCAPE, ctx({ world: [50, 50] }));
    expect(state.kind).toBe('idle');
    expect(intents).toEqual([{ kind: 'abortTransaction' }]);
  });
});

/* ---------------------------------------------------------------- panning -- */

describe('panning', () => {
  const panning: InteractionState = {
    kind: 'panning',
    originScreenX: 100,
    originScreenY: 50,
    originPanX: 10,
    originPanY: 20,
  };

  it('pans absolutely from the gesture origin', () => {
    const { intents } = reduce(panning, MOVE, ctx({ screen: [140, 30] }));
    expect(intents).toEqual([{ kind: 'panTo', panX: 50, panY: 0 }]);
  });

  it('ends cleanly on pointerup and never touches history', () => {
    const { state, intents } = reduce(panning, UP, ctx());
    expect(state.kind).toBe('idle');
    expect(intents).toEqual([]);
  });

  it('puts the camera back on Escape', () => {
    const { intents } = reduce(panning, ESCAPE, ctx({ screen: [400, 400] }));
    expect(intents).toEqual([{ kind: 'panTo', panX: 10, panY: 20 }]);
  });
});

/* ------------------------------------------------------------------- text -- */

describe('text editing', () => {
  it('enters editing-text by double-clicking a text element', () => {
    const { state, intents } = reduce(IDLE, { kind: 'doubleclick' }, ctx({ hit: onText }));
    expect(state).toEqual({ kind: 'editing-text', elementId: 't' });
    expect(intents).toEqual([{ kind: 'beginTextEdit', elementId: 't' }]);
  });

  it('ignores a double-click on anything else', () => {
    for (const hit of [onElement, { kind: 'none' } as InteractionHit]) {
      const result = reduce(IDLE, { kind: 'doubleclick' }, ctx({ hit }));
      expect(result.state).toBe(IDLE);
      expect(result.intents).toEqual([]);
    }
  });

  it('leaves the caret on a press elsewhere and on Escape', () => {
    const editing: InteractionState = { kind: 'editing-text', elementId: 't' };
    expect(reduce(editing, DOWN, ctx()).intents).toEqual([{ kind: 'endTextEdit' }]);
    expect(reduce(editing, ESCAPE, ctx()).state.kind).toBe('idle');
  });
});

/* ----------------------------------------------------------------- groups -- */

describe('groups', () => {
  it('treats a press on a member of the selected group as a press on the selection', () => {
    // The selection holds the group id, not the leaf under the cursor, so the
    // membership test has to run against `selectId` - otherwise dragging a
    // group would first collapse it to the one member that got hit.
    const { state, intents } = reduce(IDLE, DOWN, ctx({ hit: onGrouped, selection: ['g'] }));
    expect(state.kind).toBe('pending-drag');
    expect(intents).toEqual([]);
  });

  it('emits the leaf id and lets the executor resolve it', () => {
    // Resolution needs the element tree, which is the adapter's side of the
    // wall; the machine deals in the id it was handed.
    const { intents } = reduce(IDLE, DOWN, ctx({ hit: onGrouped }));
    expect(intents).toEqual([{ kind: 'select', ids: ['a'] }]);
  });

  it('descends into the group on a double-click and reselects through it', () => {
    const { state, intents } = reduce(IDLE, { kind: 'doubleclick' }, ctx({ hit: onGrouped }));
    expect(state).toEqual(IDLE);
    expect(intents).toEqual([
      { kind: 'enterGroup', groupId: 'g' },
      // The leaf again: the executor re-reads the store between intents, so this
      // resolves against the group that was just entered and lands one level in.
      { kind: 'select', ids: ['a'] },
    ]);
  });

  it('prefers descending over opening the caret for text inside a group', () => {
    const groupedText: InteractionHit = {
      kind: 'element',
      id: 't',
      type: 'text',
      selectId: 'g',
      enterGroupId: 'g',
    };
    const { intents } = reduce(IDLE, { kind: 'doubleclick' }, ctx({ hit: groupedText }));
    expect(kinds(intents)).toEqual(['enterGroup', 'select']);
  });

  it('leaves the group when the press lands on empty canvas', () => {
    const { state, intents } = reduce(IDLE, DOWN, ctx({ enteredGroupId: 'g' }));
    expect(state.kind).toBe('marquee');
    expect(intents).toEqual([{ kind: 'enterGroup', groupId: null }]);
  });

  it('keeps the entered group on a shift-press, since additive gestures elsewhere never destroy state', () => {
    // toggleSelect and the marquee's `additive` flag are both purely additive
    // under Shift; an empty-canvas shift-press silently leaving the group
    // would be the one Shift gesture in this machine that discards something.
    const { state, intents } = reduce(
      IDLE,
      DOWN,
      ctx({ enteredGroupId: 'g', modifiers: { shift: true } })
    );
    expect(state).toMatchObject({ kind: 'marquee', additive: true });
    expect(intents).toEqual([]);
  });

  it('does not emit an exit when there is nothing to leave', () => {
    expect(reduce(IDLE, DOWN, ctx()).intents).toEqual([]);
  });
});

/* ------------------------------------------------------------------ misc -- */

describe('reduce', () => {
  it('ignores keys other than Escape', () => {
    const dragging: InteractionState = {
      kind: 'dragging',
      originWorld: worldPoint(0, 0),
      currentWorld: worldPoint(0, 0),
    };
    const result = reduce(dragging, { kind: 'keydown', key: 'a' }, ctx());
    expect(result.state).toBe(dragging);
    expect(result.intents).toEqual([]);
  });

  it('returns the identical state object when nothing changed, so the adapter can skip the write', () => {
    const result = reduce(IDLE, MOVE, ctx({ hit: onElement }));
    expect(result.state).toBe(IDLE);
  });

  it('never emits abortTransaction from a state that opened none', () => {
    const noTransaction: InteractionState[] = [
      IDLE,
      { kind: 'pending-drag', originWorld: worldPoint(0, 0), targetId: 'a', additive: false },
      {
        kind: 'marquee',
        originWorld: worldPoint(0, 0),
        currentWorld: worldPoint(0, 0),
        additive: false,
      },
      { kind: 'panning', originScreenX: 0, originScreenY: 0, originPanX: 0, originPanY: 0 },
      { kind: 'editing-text', elementId: 't' },
    ];
    for (const state of noTransaction) {
      expect(kinds(reduce(state, CANCEL, ctx()).intents)).not.toContain('abortTransaction');
    }
  });
});

describe('sticky aspect lock', () => {
  it('preserves aspect on resize when the panel toggle is on, without Shift', () => {
    // The toggle and the Shift key are two ways to ask for the same thing, so
    // the machine ORs them. Before this was threaded through, the panel's
    // toggle coupled its own W/H fields and the canvas handles ignored it -
    // a control that appears to do one thing and does half of it.
    const down = reduce(
      IDLE,
      { kind: 'pointerdown', button: 'primary' },
      ctx({ hit: { kind: 'handle', handle: 'se' }, lockAspect: true })
    );
    expect(down.state).toMatchObject({ kind: 'resizing', preserveAspect: true });

    const moved = reduce(down.state, { kind: 'pointermove' }, ctx({ world: [50, 10], lockAspect: true }));
    expect(moved.intents).toContainEqual(expect.objectContaining({ kind: 'resize', preserveAspect: true }));
  });

  it('still preserves aspect from Shift alone when the toggle is off', () => {
    const down = reduce(
      IDLE,
      { kind: 'pointerdown', button: 'primary' },
      ctx({ hit: { kind: 'handle', handle: 'se' }, modifiers: { shift: true } })
    );
    expect(down.state).toMatchObject({ kind: 'resizing', preserveAspect: true });
  });
});

describe('a locked selection', () => {
  it('refuses to start a resize from a handle', () => {
    // Hit-testing already refuses to *pick* a locked element, but a selection
    // made from the layers panel bypasses that - which is how a locked element
    // ended up draggable by its handles.
    const result = reduce(
      IDLE,
      { kind: 'pointerdown', button: 'primary' },
      ctx({ hit: { kind: 'handle', handle: 'se' }, selectionLocked: true })
    );

    expect(result.state).toEqual(IDLE);
    expect(result.intents).toHaveLength(0);
  });

  it('refuses to start a rotation', () => {
    const result = reduce(
      IDLE,
      { kind: 'pointerdown', button: 'primary' },
      ctx({ hit: { kind: 'handle', handle: 'rotate' }, selectionLocked: true, center: [0, 0] })
    );

    expect(result.state).toEqual(IDLE);
    expect(result.intents).toHaveLength(0);
  });

  it('still allows a handle gesture when only some of the selection is locked', () => {
    // Partially-locked selections keep their handles: the unlocked members are
    // still legitimately transformable.
    const result = reduce(
      IDLE,
      { kind: 'pointerdown', button: 'primary' },
      ctx({ hit: { kind: 'handle', handle: 'se' }, selectionLocked: false })
    );

    expect(result.state).toMatchObject({ kind: 'resizing' });
  });
});
