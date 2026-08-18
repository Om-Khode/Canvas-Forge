import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PropertiesPanel } from './PropertiesPanel';
import {
  createEllipse,
  createLine,
  createRectangle,
  createText,
} from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store/index';
import type { CanvasElement } from '@/types';
import { worldPoint, worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();

function seed(...elements: CanvasElement[]): void {
  state().addElements(elements);
  state().select(elements.map((element) => element.id));
  // Seeding is fixture setup, not something the tests should have to undo past.
  useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
}

/**
 * Drags a NumberField's label through `path`, which is how the panel's scrub
 * gesture starts. The number of intermediate moves is a parameter because it is
 * the variable a real drag varies: at 2px per step, a scrub the width of the
 * panel is a hundred `onChange` calls at whatever rate the pointer reports.
 */
function scrubThrough(label: HTMLElement, from: number, path: readonly number[]): void {
  fireEvent.pointerDown(label, { clientX: from, button: 0 });
  for (const clientX of path) fireEvent.pointerMove(window, { clientX });
  fireEvent.pointerUp(window, { clientX: path[path.length - 1] ?? from });
}

function scrub(label: HTMLElement, from: number, to: number): void {
  scrubThrough(label, from, [(from + to) / 2, to]);
}

beforeEach(() => {
  resetCanvasStore();
});

describe('empty selection', () => {
  it('explains what to do and offers the active tool defaults', () => {
    state().setTool('rectangle');
    render(<PropertiesPanel />);

    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
    // The point of showing defaults: choose a fill, *then* draw.
    expect(screen.getByRole('button', { name: /^Fill:/ })).toBeInTheDocument();
  });

  it('writes tool defaults to the tool slice, not to history', async () => {
    const user = userEvent.setup();
    state().setTool('ellipse');
    render(<PropertiesPanel />);

    await user.selectOptions(screen.getByLabelText('Width'), '4');

    expect(state().defaultStyles.ellipse.strokeWidth).toBe(4);
    // Defaults are not part of the document, so Ctrl+Z must not reach them.
    expect(state().history.past).toHaveLength(0);
  });

  it('offers no fill for a tool whose elements have none', () => {
    state().setTool('line');
    render(<PropertiesPanel />);

    expect(screen.queryByRole('button', { name: /^Fill:/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Width')).toBeInTheDocument();
  });

  it('says nothing about style for a tool that creates nothing', () => {
    state().setTool('select');
    render(<PropertiesPanel />);

    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).not.toBeInTheDocument();
  });
});

describe('single selection', () => {
  it('shows the element type and its geometry', () => {
    seed(createRectangle(worldRect(10, 20, 100, 50)));
    render(<PropertiesPanel />);

    expect(screen.getByText('Rectangle')).toBeInTheDocument();
    expect(screen.getByLabelText('X')).toHaveValue(10);
    expect(screen.getByLabelText('Y')).toHaveValue(20);
    expect(screen.getByLabelText('W')).toHaveValue(100);
    expect(screen.getByLabelText('H')).toHaveValue(50);
  });

  it('shows rotation in degrees', () => {
    const rect = createRectangle(worldRect(0, 0, 10, 10));
    seed(rect);
    state().updateElement(rect.id, { rotation: Math.PI / 2 });
    render(<PropertiesPanel />);

    expect(screen.getByLabelText('Angle')).toHaveValue(90);
  });
});

describe('transactions', () => {
  it('turns a whole scrub into ONE undo entry', () => {
    const rect = createRectangle(worldRect(0, 0, 100, 50));
    seed(rect);
    render(<PropertiesPanel />);

    scrub(screen.getByText('X'), 100, 140);

    // 40px of travel at 2px per step = +20, and the intermediate move wrote a
    // value too - but the transaction swallowed every step but the outcome.
    expect(state().elements.byId[rect.id]?.x).toBe(20);
    expect(state().history.past).toHaveLength(1);
  });

  it('leaves no entry when a scrub ends where it started', () => {
    seed(createRectangle(worldRect(0, 0, 100, 50)));
    render(<PropertiesPanel />);

    scrub(screen.getByText('X'), 100, 100);

    expect(state().history.past).toHaveLength(0);
  });

  it('updates in place while the document changes underneath it', () => {
    const rect = createRectangle(worldRect(0, 0, 100, 50));
    seed(rect);
    render(<PropertiesPanel />);

    const y = screen.getByLabelText('Y');
    y.focus();
    // Stands in for a canvas drag writing a position every frame.
    act(() => {
      state().updateElement(rect.id, { x: 500 });
    });

    // Same DOM node, still focused: the panel re-rendered, it did not remount.
    // A remount here would drop focus and abandon whatever the user was typing.
    expect(screen.getByLabelText('Y')).toBe(y);
    expect(y).toHaveFocus();
    expect(screen.getByLabelText('X')).toHaveValue(500);
  });

  it('makes a typed value one entry as well', async () => {
    const user = userEvent.setup();
    const rect = createRectangle(worldRect(0, 0, 100, 50));
    seed(rect);
    render(<PropertiesPanel />);

    const input = screen.getByLabelText('X');
    await user.clear(input);
    await user.type(input, '250{Enter}');

    expect(state().elements.byId[rect.id]?.x).toBe(250);
    expect(state().history.past).toHaveLength(1);
  });

  it('keeps the aspect ratio when the lock is on', async () => {
    const user = userEvent.setup();
    const rect = createRectangle(worldRect(0, 0, 100, 50));
    seed(rect);
    render(<PropertiesPanel />);

    await user.click(screen.getByRole('switch', { name: 'Lock aspect ratio' }));
    const width = screen.getByLabelText('W');
    await user.clear(width);
    await user.type(width, '200{Enter}');

    expect(state().elements.byId[rect.id]?.width).toBe(200);
    expect(state().elements.byId[rect.id]?.height).toBe(100);
  });
});

describe('aspect lock', () => {
  it('is a tool mode, so it survives a change of selection', async () => {
    const user = userEvent.setup();
    const a = createRectangle(worldRect(0, 0, 100, 50));
    const b = createRectangle(worldRect(200, 0, 40, 40));
    seed(a, b);
    state().select([a.id]);
    render(<PropertiesPanel />);

    await user.click(screen.getByRole('switch', { name: 'Lock aspect ratio' }));
    expect(screen.getByRole('switch', { name: 'Lock aspect ratio' })).toBeChecked();

    act(() => {
      state().select([b.id]);
    });

    // Not per element, by design: the canvas resize handles OR the same flag
    // with Shift, so it is a mode the editor is in rather than a property of
    // whatever happens to be selected. A user reported the carry-over as a bug,
    // so pin it here - if it ever becomes per-element that is a decision, not a
    // silent change of behaviour.
    expect(screen.getByRole('switch', { name: 'Lock aspect ratio' })).toBeChecked();

    const width = screen.getByLabelText('W');
    await user.clear(width);
    await user.type(width, '80{Enter}');

    // Still coupling W to H, now for the element selected second.
    expect(state().elements.byId[b.id]?.height).toBe(80);
  });
});

describe('multi-selection', () => {
  it('reports a disagreement rather than one element’s value', () => {
    seed(createRectangle(worldRect(0, 0, 10, 10)), createRectangle(worldRect(80, 0, 10, 10)));
    render(<PropertiesPanel />);

    expect(screen.getByLabelText('X')).toHaveAttribute('placeholder', 'Mixed');
    // They agree on size, so that is shown as a value.
    expect(screen.getByLabelText('W')).toHaveValue(10);
  });

  it('labels a mixed fill as mixed', () => {
    seed(
      createRectangle(worldRect(0, 0, 10, 10), { style: { fill: '#111111' } }),
      createEllipse(worldRect(20, 0, 10, 10), { style: { fill: '#222222' } })
    );
    render(<PropertiesPanel />);

    expect(screen.getByRole('button', { name: /^Fill \(mixed\):/ })).toBeInTheDocument();
  });

  it('patches only the elements that carry the property', async () => {
    const user = userEvent.setup();
    const rect = createRectangle(worldRect(0, 0, 10, 10));
    const line = createLine(worldPoint(0, 0), worldPoint(10, 10));
    seed(rect, line);
    const lineBefore = state().elements.byId[line.id];
    render(<PropertiesPanel />);

    await user.click(screen.getByRole('button', { name: /^Fill:/ }));
    await user.click(screen.getByRole('button', { name: '#3f7d58' }));

    expect(state().elements.byId[rect.id]).toMatchObject({ fill: '#3f7d58' });
    // Untouched *by identity*: the line never received a `fill` key, so it is
    // still the same object and still passes validation.
    expect(state().elements.byId[line.id]).toBe(lineBefore);
    expect(state().history.past).toHaveLength(1);
  });

  it('hides a control no selected element supports', () => {
    seed(
      createLine(worldPoint(0, 0), worldPoint(10, 10)),
      createLine(worldPoint(20, 0), worldPoint(30, 10))
    );
    render(<PropertiesPanel />);

    expect(screen.queryByRole('button', { name: /^Fill/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Stroke:/ })).toBeInTheDocument();
  });

  it('shows the text section only when the selection contains text', () => {
    seed(createRectangle(worldRect(0, 0, 10, 10)));
    const { unmount } = render(<PropertiesPanel />);
    expect(screen.queryByRole('heading', { name: 'Text' })).not.toBeInTheDocument();
    unmount();

    seed(createText(worldRect(0, 0, 100, 40)));
    render(<PropertiesPanel />);
    expect(screen.getByRole('heading', { name: 'Text' })).toBeInTheDocument();
    expect(screen.getByLabelText('Font')).toBeInTheDocument();
  });

  it('shows corner radius only when a rectangle is selected', () => {
    seed(createEllipse(worldRect(0, 0, 10, 10)));
    const { unmount } = render(<PropertiesPanel />);
    expect(screen.queryByLabelText('Radius')).not.toBeInTheDocument();
    unmount();

    seed(createRectangle(worldRect(0, 0, 10, 10)));
    render(<PropertiesPanel />);
    expect(screen.getByLabelText('Radius')).toBeInTheDocument();
  });
});

describe('arrange', () => {
  it('aligns the selection in one undo entry', async () => {
    const user = userEvent.setup();
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 0, 10, 10));
    const c = createRectangle(worldRect(90, 0, 10, 10));
    seed(a, b, c);
    render(<PropertiesPanel />);

    await user.click(screen.getByRole('button', { name: 'Align left' }));

    expect(state().elements.byId[b.id]?.x).toBe(0);
    expect(state().elements.byId[c.id]?.x).toBe(0);
    expect(state().history.past).toHaveLength(1);
  });

  it('disables distribute below three elements', () => {
    seed(createRectangle(worldRect(0, 0, 10, 10)), createRectangle(worldRect(40, 0, 10, 10)));
    render(<PropertiesPanel />);

    expect(screen.getByRole('button', { name: 'Distribute horizontally' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Align left' })).toBeEnabled();
  });

  it('reorders layers from the panel', async () => {
    const user = userEvent.setup();
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 0, 10, 10));
    state().addElements([a, b]);
    state().select([a.id]);
    render(<PropertiesPanel />);

    await user.click(screen.getByRole('button', { name: 'Bring to front' }));

    expect(state().elements.order).toEqual([b.id, a.id]);
  });
});

describe('group selection', () => {
  /**
   * A group of two 10×10 squares whose derived box is (0, 0, 50, 50) - so the
   * pivot every rotation assertion below is computed against is (25, 25), and a
   * quarter turn lands on whole numbers.
   */
  function seedGroup(): { a: string; b: string } {
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    state().addElements([a, b]);
    state().select([state().group([a.id, b.id]) ?? '']);
    return { a: a.id, b: b.id };
  }

  /** Fixture setup is not something a test should have to undo past. */
  function forgetHistory(): void {
    useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
  }

  /*
    A group's x/y/width/height are a cache re-derived on every write, so a patch
    naming them is erased inside the same write - which is why these fields were
    once switched off (review round-1 finding 2). The user pointed out what that
    misses: the canvas moves and resizes a group perfectly well by dragging its
    frame, because it patches the *leaves*. So does the panel now.
  */
  it('shows the derived box and edits it through the leaves', async () => {
    const user = userEvent.setup();
    const { a, b } = seedGroup();
    forgetHistory();
    render(<PropertiesPanel />);

    for (const label of ['X', 'Y', 'W', 'H']) {
      expect(screen.getByLabelText(label)).toBeEnabled();
    }
    expect(screen.getByLabelText('W')).toHaveValue(50);

    const width = screen.getByLabelText('W');
    await user.clear(width);
    await user.type(width, '100{Enter}');

    // Doubling the 50-wide box doubles each member and the gap between them.
    // Nothing wrote to the group: its box is recomputed from what moved.
    expect(state().elements.byId[a]?.width).toBe(20);
    expect(state().elements.byId[b]?.x).toBe(80);
    expect(screen.getByLabelText('W')).toHaveValue(100);
    expect(state().history.past).toHaveLength(1);
  });

  it('translates the members when the group’s X is typed', async () => {
    const user = userEvent.setup();
    const { a, b } = seedGroup();
    forgetHistory();
    render(<PropertiesPanel />);

    const x = screen.getByLabelText('X');
    await user.clear(x);
    await user.type(x, '25{Enter}');

    // Rigid, not a scale: both members shift by the same 25 and keep their size.
    expect(state().elements.byId[a]).toMatchObject({ x: 25, width: 10 });
    expect(state().elements.byId[b]).toMatchObject({ x: 65, width: 10 });
    expect(screen.getByLabelText('X')).toHaveValue(25);
  });

  it('turns a group size scrub into ONE undo entry', () => {
    const { a } = seedGroup();
    forgetHistory();
    render(<PropertiesPanel />);

    scrub(screen.getByText('W'), 100, 140);

    // 40px of travel at 2px per step takes the 50-wide box to 70, so every
    // member is scaled by 1.4 - and the dozens of intermediate writes collapse
    // into the one entry the transaction bracketed.
    expect(state().elements.byId[a]?.width).toBeCloseTo(14, 9);
    expect(state().history.past).toHaveLength(1);
  });

  it('leaves no entry when a group size scrub ends where it started', () => {
    seedGroup();
    forgetHistory();
    const before = state().elements;
    render(<PropertiesPanel />);

    scrub(screen.getByText('W'), 100, 100);

    // Reference-identical: every event of the scrub is replayed against the
    // geometry frozen at pointerdown, so the closing one restores it verbatim.
    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(0);
  });

  it('couples W to H for a group once the aspect lock is on', async () => {
    const user = userEvent.setup();
    // A 50×25 box, so the ratio is a real 0.5 rather than a square's 1.
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 15, 10, 10));
    state().addElements([a, b]);
    state().select([state().group([a.id, b.id]) ?? '']);
    forgetHistory();
    render(<PropertiesPanel />);

    const lock = screen.getByRole('switch', { name: 'Lock aspect ratio' });
    expect(lock).toBeEnabled();
    await user.click(lock);

    const width = screen.getByLabelText('W');
    await user.clear(width);
    await user.type(width, '100{Enter}');

    // The ratio is read from the derived box the edit is measured against, so
    // both axes get the same scale and the members keep their arrangement.
    expect(screen.getByLabelText('H')).toHaveValue(50);
    expect(state().elements.byId[a.id]).toMatchObject({ width: 20, height: 20 });
    expect(state().elements.byId[b.id]).toMatchObject({ x: 80, y: 30 });
  });

  /*
    The lock plus a scrub, at the level the failure was reported from. The ratio
    used to be computed in `PositionSection` from the values the fields were
    showing - i.e. from the state the previous event of the same scrub had just
    produced - so it survived as one live read inside a replay loop. This fixture
    is what exposes that: the group's right edge is set by a 5px tick that clamps
    at `MIN_ELEMENT_SIZE` on the first event down, which inflates the union's
    width, which poisons the ratio for the next event. A typed 10 landed at
    H = 9, a hundred-event scrub to the same 10 landed at H = 6.708.
  */
  function seedThinEdgeGroup(): string {
    const bar = createRectangle(worldRect(0, 0, 190, 10));
    const tick = createRectangle(worldRect(195, 100, 5, 5));
    const upright = createRectangle(worldRect(50, 0, 20, 180));
    state().addElements([bar, tick, upright]);
    const group = state().group([bar.id, tick.id, upright.id]) ?? '';
    state().select([group]);
    forgetHistory();
    return group;
  }

  function boxOf(id: string): readonly (number | undefined)[] {
    const group = state().elements.byId[id];
    return [group?.width, group?.height];
  }

  it('lands a locked W scrub where the typed value lands, in one entry', async () => {
    const user = userEvent.setup();
    const first = seedThinEdgeGroup();
    const view = render(<PropertiesPanel />);

    await user.click(screen.getByRole('switch', { name: 'Lock aspect ratio' }));
    const width = screen.getByLabelText('W');
    await user.clear(width);
    await user.type(width, '10{Enter}');
    const typed = boxOf(first);
    // Unmounted before the second run so there is only ever one W field on
    // screen - and so the lock goes back to off with the rest of the store.
    view.unmount();
    resetCanvasStore();

    const second = seedThinEdgeGroup();
    render(<PropertiesPanel />);
    await user.click(screen.getByRole('switch', { name: 'Lock aspect ratio' }));

    // 380px of travel at 2px per step takes the 200-wide box to exactly 10 - the
    // same edit as above, in a hundred `onChange` calls instead of one.
    scrubThrough(
      screen.getByText('W'),
      500,
      Array.from({ length: 100 }, (_, index) => 500 - 3.8 * (index + 1))
    );

    expect(boxOf(second)).toEqual(typed);
    expect(state().history.past).toHaveLength(1);
  });

  it('disables the whole Transform section only when every member is locked', () => {
    const { a, b } = seedGroup();
    state().updateElement(a, { locked: true });
    state().updateElement(b, { locked: true });
    render(<PropertiesPanel />);

    expect(screen.getByLabelText('X')).toBeDisabled();
    expect(screen.getByLabelText('W')).toBeDisabled();
    expect(screen.getByLabelText('Angle')).toBeDisabled();
    // Still reading the derived 50×50 box - disabling beats hiding information
    // the user can see on the canvas.
    expect(screen.getByLabelText('W')).toHaveValue(50);
  });

  // The reported defect: a group's own `rotation` is the one number in the
  // document nothing ever writes - the canvas gesture turns the *leaves* - so a
  // field reading it said 0 while the group visibly turned on screen.
  it('reads the leaves’ angle rather than the group’s own, and stays editable', () => {
    const { a, b } = seedGroup();
    state().updateElement(a, { rotation: Math.PI / 2 });
    state().updateElement(b, { rotation: Math.PI / 2 });
    render(<PropertiesPanel />);

    const angle = screen.getByLabelText('Angle');
    expect(angle).toHaveValue(90);
    expect(angle).toBeEnabled();
  });

  it('reports a splayed group as mixed rather than picking a leaf', () => {
    const { a } = seedGroup();
    state().updateElement(a, { rotation: Math.PI / 2 });
    render(<PropertiesPanel />);

    expect(screen.getByLabelText('Angle')).toHaveAttribute('placeholder', 'Mixed');
  });

  // The whole point of the delta semantics: a typed angle has to leave the group
  // where dragging the handle to that angle would have left it.
  it('turns the descendants as one body, in one undo entry', async () => {
    const user = userEvent.setup();
    const { a, b } = seedGroup();
    forgetHistory();
    render(<PropertiesPanel />);

    const angle = screen.getByLabelText('Angle');
    await user.clear(angle);
    await user.type(angle, '90{Enter}');

    // Leaf A's centre (5, 5) is (-20, -20) from the pivot, which a quarter turn
    // sends to (20, -20) - centre (45, 5), so a 10×10 box at (40, 0).
    expect(state().elements.byId[a]?.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(state().elements.byId[a]?.x).toBeCloseTo(40, 10);
    expect(state().elements.byId[a]?.y).toBeCloseTo(0, 10);
    expect(state().elements.byId[b]?.x).toBeCloseTo(0, 10);
    expect(state().elements.byId[b]?.y).toBeCloseTo(40, 10);
    expect(state().history.past).toHaveLength(1);
  });

  it('leaves a locked member alone', async () => {
    const user = userEvent.setup();
    const { a, b } = seedGroup();
    state().updateElement(a, { locked: true });
    const locked = state().elements.byId[a];
    render(<PropertiesPanel />);

    const angle = screen.getByLabelText('Angle');
    await user.clear(angle);
    await user.type(angle, '90{Enter}');

    // Reference-identical, not merely equal: a locked leaf must not even be
    // rebuilt, or structural sharing would report it as changed.
    expect(state().elements.byId[a]).toBe(locked);
    expect(state().elements.byId[b]?.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it('records nothing for the angle already in the field', async () => {
    const user = userEvent.setup();
    const { a, b } = seedGroup();
    state().updateElement(a, { rotation: Math.PI / 2 });
    state().updateElement(b, { rotation: Math.PI / 2 });
    forgetHistory();
    const before = state().elements;
    render(<PropertiesPanel />);

    const angle = screen.getByLabelText('Angle');
    await user.clear(angle);
    await user.type(angle, '90{Enter}');

    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(0);
  });

  it('leaves no entry when an angle scrub ends where it started', () => {
    const { a, b } = seedGroup();
    // An angle a rotate *gesture* would leave behind, chosen because
    // `normalizeAngle` is not bit-idempotent on it: the degrees round trip the
    // field makes comes back 8.9e-16 off, which without a tolerance is a real
    // patch - so a click on the label that moved nothing would cost an undo
    // entry, and orbit every member by a hundredth of a nanoradian while it was
    // at it.
    const gestured = 2.986844219970288;
    state().updateElement(a, { rotation: gestured });
    state().updateElement(b, { rotation: gestured });
    forgetHistory();
    const before = state().elements;
    render(<PropertiesPanel />);

    scrub(screen.getByText('Angle'), 100, 100);

    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(0);
  });

  /*
    C1: the field's *scrub* is not one edit, it is one `onChange` per pointermove
    - a hundred of them over a real drag. Recomputing "the delta from the angle
    the document currently holds, about the pivot it currently has" per event
    composes a hundred rotations about a pivot that moves as the group turns, so
    the group walks (27 world units on this fixture, 77 on the review's) and
    where it stops depends on the frame rate. The symmetric fixture above cannot
    see any of that: its pivot is invariant under rotation about itself.
  */
  function seedAsymmetric(): { bar: string; square: string; box: string } {
    const bar = createRectangle(worldRect(0, 0, 200, 10));
    const square = createRectangle(worldRect(0, 100, 10, 10));
    const box = createRectangle(worldRect(150, 60, 40, 120));
    state().addElements([bar, square, box]);
    state().select([state().group([bar.id, square.id, box.id]) ?? '']);
    return { bar: bar.id, square: square.id, box: box.id };
  }

  function geometryOf(ids: readonly string[]): readonly (readonly number[])[] {
    return ids.map((id) => {
      const element = state().elements.byId[id];
      return [element?.x ?? NaN, element?.y ?? NaN, element?.rotation ?? NaN];
    });
  }

  /** One angle scrub through `path`, on a fresh document, with the panel mounted. */
  function scrubAngle(path: readonly number[]): readonly (readonly number[])[] {
    resetCanvasStore();
    const { bar, square, box } = seedAsymmetric();
    const view = render(<PropertiesPanel />);

    scrubThrough(screen.getByText('Angle'), 100, path);

    const geometry = geometryOf([bar, square, box]);
    view.unmount();
    return geometry;
  }

  function expectSameGeometry(
    actual: readonly (readonly number[])[],
    expected: readonly (readonly number[])[]
  ): void {
    actual.forEach((values, index) => {
      values.forEach((value, axis) => {
        expect(value).toBeCloseTo(expected[index]?.[axis] ?? NaN, 9);
      });
    });
  }

  /** 180px of travel at 2px per step is 90°, in `count` moves. */
  function travelTo90(count: number): readonly number[] {
    return Array.from({ length: count }, (_, index) => 100 + (180 * (index + 1)) / count);
  }

  it('scrubs an asymmetric group about the pivot the gesture started with', () => {
    const { bar, square, box } = seedAsymmetric();
    forgetHistory();
    render(<PropertiesPanel />);

    scrubThrough(screen.getByText('Angle'), 100, travelTo90(90));

    // A rigid quarter turn about (100, 90), computed from the geometry: the bar's
    // centre (100, 5) is (0, -85) from the pivot, which a quarter turn sends to
    // (85, 0) - centre (185, 90), so a 200×10 box at (85, 85).
    const { byId } = state().elements;
    expect(byId[bar]?.x).toBeCloseTo(85, 9);
    expect(byId[bar]?.y).toBeCloseTo(85, 9);
    expect(byId[square]?.x).toBeCloseTo(80, 9);
    expect(byId[square]?.y).toBeCloseTo(-10, 9);
    expect(byId[box]?.x).toBeCloseTo(50, 9);
    expect(byId[box]?.y).toBeCloseTo(100, 9);
    expect(byId[bar]?.rotation).toBeCloseTo(Math.PI / 2, 9);
    // Ninety `onChange` calls, one undo entry - the transaction the scrub opens.
    expect(state().history.past).toHaveLength(1);
  });

  it('lands a scrub where the same angle typed once lands it', async () => {
    const user = userEvent.setup();
    const scrubbed = scrubAngle(travelTo90(90));

    resetCanvasStore();
    const { bar, square, box } = seedAsymmetric();
    render(<PropertiesPanel />);
    const angle = screen.getByLabelText('Angle');
    await user.clear(angle);
    await user.type(angle, '90{Enter}');

    expectSameGeometry(geometryOf([bar, square, box]), scrubbed);
  });

  it('does not depend on how many pointermove events the drag produced', () => {
    // Same gesture, same start and end pixel, different sampling rate.
    expectSameGeometry(scrubAngle(travelTo90(240)), scrubAngle(travelTo90(2)));
  });

  /*
    A scrub that is never ended by a pointerup, because the field it lives on
    disappeared first. Escape (`edit.clear-selection`) and Delete both empty the
    selection from the keyboard while the mouse is still held - a panel scrub
    leaves `interaction.kind === 'idle'`, so neither command is disabled - and an
    empty selection swaps the whole section out for the tool defaults. The field
    unmounts mid-gesture, so `NumberField`'s effect cleanup is the only thing
    left that can end the scrub.

    Two things leak if it doesn't, and the second is specific to the angle field:
    the open transaction (undo dies for the rest of the session) and the frozen
    `RotationSnapshot`, which would then become the origin of the next typed
    angle - aimed at a selection that no longer exists.
  */
  it('releases both the transaction and the snapshot when a scrub is torn down by unmount', async () => {
    const user = userEvent.setup();
    const { bar } = seedAsymmetric();
    // Somewhere else entirely, and not selected: the target of the *next* edit.
    const loose = createRectangle(worldRect(500, 500, 20, 20));
    state().addElements([loose]);
    forgetHistory();
    render(<PropertiesPanel />);

    fireEvent.pointerDown(screen.getByText('Angle'), { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 160 });
    expect(state().history.depth).toBe(1);

    // Escape, mid-drag. No pointerup ever arrives.
    act(() => {
      state().clearSelection();
    });
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();

    // Half one: the gesture is closed, so it is one undo entry and undo works.
    expect(state().history.depth).toBe(0);
    expect(state().history.past).toHaveLength(1);

    // Half two: the next typed angle must land on the new selection. Snapshots
    // are captured *per gesture*, so a stale one would rotate the group again
    // and leave this rectangle at 0.
    const turned = state().elements.byId[bar];
    act(() => {
      state().select([loose.id]);
    });
    const angle = screen.getByLabelText('Angle');
    await user.clear(angle);
    await user.type(angle, '45{Enter}');

    expect(state().elements.byId[loose.id]?.rotation).toBeCloseTo(Math.PI / 4, 9);
    // Reference-identical: the deselected group was not part of this edit at all.
    expect(state().elements.byId[bar]).toBe(turned);
  });

  it('re-enables the fields once nothing selected is a group', () => {
    seed(createRectangle(worldRect(0, 0, 10, 10)));
    render(<PropertiesPanel />);

    expect(screen.getByLabelText('X')).toBeEnabled();
  });

  // A mixed selection the spec explicitly allows, and the case that used to
  // switch X/Y/W/H off for the loose element too because something else in the
  // selection could not accept them. Now both can, by different means.
  it('serves a group and a loose element in one selection, each its own way', async () => {
    const user = userEvent.setup();
    const a = createRectangle(worldRect(0, 0, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    const loose = createRectangle(worldRect(100, 0, 20, 20));
    state().addElements([a, b, loose]);
    const groupId = state().group([a.id, b.id]) ?? '';
    state().select([groupId, loose.id]);
    forgetHistory();
    render(<PropertiesPanel />);

    const width = screen.getByLabelText('W');
    expect(width).toBeEnabled();
    // The group's 50-wide box against the loose element's 20: a disagreement,
    // reported as one rather than settled by picking a side.
    expect(width).toHaveAttribute('placeholder', 'Mixed');

    await user.clear(width);
    await user.type(width, '100{Enter}');

    // The loose element takes 100 outright. The group reaches it by scaling its
    // members, which is the only way a derived box can reach anything.
    expect(state().elements.byId[loose.id]?.width).toBe(100);
    expect(state().elements.byId[a.id]?.width).toBe(20);
    expect(state().elements.byId[b.id]?.x).toBe(80);
    expect(state().elements.byId[groupId]?.width).toBe(100);
    // One typed value, one undo entry, however many elements it landed on.
    expect(state().history.past).toHaveLength(1);
  });
});

describe('a selection made inside a group', () => {
  // Review round-1 finding 4: this exercises the paint-order fallback
  // `selectSelectionInOrder` falls back to when the selection is not entirely
  // root ids (`Task 6`'s C5 fix), which previously shipped with no test of
  // its own, and now runs through the memoized cache added alongside it.
  it('reports the member’s own properties, not "nothing selected"', () => {
    const a = createRectangle(worldRect(5, 6, 10, 10));
    const b = createRectangle(worldRect(40, 40, 10, 10));
    state().addElements([a, b]);
    const groupId = state().group([a.id, b.id]);
    expect(groupId).not.toBeNull();
    // A member selected directly, not the group - `order` holds only the
    // group id, so the cheap root filter misses and the panel must walk paint
    // order to find it.
    state().select([a.id]);
    render(<PropertiesPanel />);

    expect(screen.getByText('Rectangle')).toBeInTheDocument();
    expect(screen.getByLabelText('X')).toHaveValue(5);
    expect(screen.getByLabelText('Y')).toHaveValue(6);
  });
});
