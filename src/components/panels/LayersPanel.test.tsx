import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LayersPanel } from './LayersPanel';
import { createEllipse, createRectangle } from '@/features/elements/factory';
import { LAYER_INDENT_PX, LAYER_LIST_PADDING, LAYER_ROW_HEIGHT, LAYER_ROW_INSET_PX } from '@/constants';
import { resetCanvasStore, useCanvasStore } from '@/store/index';
import type { CanvasElement, GroupElement } from '@/types';
import { worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();
const ROW_HEIGHT = 32;

function seed(count: number): CanvasElement[] {
  const elements = Array.from({ length: count }, (_, index) =>
    createRectangle(worldRect(index * 20, 0, 10, 10), { name: `Layer ${index + 1}` })
  );
  state().addElements(elements);
  useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
  return elements;
}

const rows = (): HTMLElement[] => screen.getAllByRole('row');

const grip = (row: HTMLElement): HTMLElement => {
  const handle = row.querySelector<HTMLElement>('[data-layer-grip]');
  if (handle === null) throw new Error('row has no drag handle');
  return handle;
};

/** Drop lines and drop rings alike - the panel must draw exactly one, or none. */
const indicators = (container: HTMLElement): number =>
  container.querySelectorAll('[data-drop-indicator]').length;

/**
 * jsdom gives every element a zero-sized rect, so the hook's midpoint maths has
 * nothing to work with. Stack the rows by their display index instead.
 */
function stubRowGeometry(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ): DOMRect {
    const index = Number(this.dataset['layerIndex'] ?? '0');
    const top = index * ROW_HEIGHT;
    return {
      top,
      bottom: top + ROW_HEIGHT,
      height: ROW_HEIGHT,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
}

beforeEach(() => {
  resetCanvasStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the list', () => {
  it('says so when the document is empty', () => {
    render(<LayersPanel />);
    expect(screen.getByText('No layers yet')).toBeInTheDocument();
    expect(screen.queryByRole('row')).not.toBeInTheDocument();
  });

  it('lists elements top-first, the reverse of paint order', () => {
    seed(3);
    render(<LayersPanel />);

    // `elementOrder` is bottom-to-top, so the last-added element is on top.
    expect(rows().map((row) => row.textContent)).toEqual(['Layer 3', 'Layer 2', 'Layer 1']);
  });

  it('exposes selection state on the row', async () => {
    const user = userEvent.setup();
    seed(2);
    render(<LayersPanel />);

    await user.click(screen.getByText('Layer 1'));

    const [top, bottom] = rows();
    expect(top).toHaveAttribute('aria-selected', 'false');
    expect(bottom).toHaveAttribute('aria-selected', 'true');
  });
});

describe('selection', () => {
  it('selects on click', async () => {
    const user = userEvent.setup();
    const elements = seed(3);
    render(<LayersPanel />);

    await user.click(screen.getByText('Layer 2'));

    expect([...state().selection]).toEqual([elements[1]?.id]);
    // Selection is view state - it must never touch history.
    expect(state().history.past).toHaveLength(0);
  });

  it('extends with shift-click', async () => {
    const user = userEvent.setup();
    const elements = seed(4);
    render(<LayersPanel />);

    await user.click(screen.getByText('Layer 4'));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByText('Layer 2'));
    await user.keyboard('{/Shift}');

    // Display order is 4,3,2,1 - the range spans three rows.
    expect(state().selection.size).toBe(3);
    expect(state().selection.has(elements[0]?.id ?? '')).toBe(false);
  });

  it('reflects a selection made elsewhere', () => {
    const elements = seed(2);
    render(<LayersPanel />);

    const target = elements[0];
    if (target === undefined) throw new Error('fixture');
    // Stands in for a canvas click: the store changes, the panel follows.
    act(() => {
      state().select([target.id]);
    });

    expect(rows()[1]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('visibility and lock', () => {
  it('toggles visibility and dims the row', async () => {
    const user = userEvent.setup();
    const elements = seed(1);
    render(<LayersPanel />);

    await user.click(screen.getByRole('button', { name: 'Hide Layer 1' }));

    expect(state().elements.byId[elements[0]?.id ?? '']?.visible).toBe(false);
    expect(rows()[0]?.className).toContain('opacity-55');
    expect(screen.getByRole('button', { name: 'Show Layer 1' })).toBeInTheDocument();
  });

  it('toggles the lock and says so', async () => {
    const user = userEvent.setup();
    const elements = seed(1);
    render(<LayersPanel />);

    await user.click(screen.getByRole('button', { name: 'Lock Layer 1' }));

    expect(state().elements.byId[elements[0]?.id ?? '']?.locked).toBe(true);
    expect(screen.getByRole('button', { name: 'Unlock Layer 1' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('does not select the row when a control inside it is pressed', async () => {
    const user = userEvent.setup();
    seed(1);
    render(<LayersPanel />);

    await user.click(screen.getByRole('button', { name: 'Hide Layer 1' }));

    expect(state().selection.size).toBe(0);
  });
});

describe('rename', () => {
  it('renames on double-click and commits with Enter', async () => {
    const user = userEvent.setup();
    const elements = seed(1);
    render(<LayersPanel />);

    await user.dblClick(screen.getByText('Layer 1'));
    const input = screen.getByRole('textbox', { name: 'Layer name' });
    await user.clear(input);
    await user.type(input, 'Header{Enter}');

    expect(state().elements.byId[elements[0]?.id ?? '']?.name).toBe('Header');
    expect(screen.getByText('Header')).toBeInTheDocument();
  });

  it('starts a rename from the keyboard', async () => {
    const user = userEvent.setup();
    seed(1);
    render(<LayersPanel />);

    rows()[0]?.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('textbox', { name: 'Layer name' })).toHaveFocus();
  });

  it('lets the field own its keystrokes', async () => {
    const user = userEvent.setup();
    const elements = seed(1);
    render(<LayersPanel />);

    // Started from the keyboard so nothing has selected the row yet.
    rows()[0]?.focus();
    await user.keyboard('{Enter}');
    const input = screen.getByRole('textbox', { name: 'Layer name' });
    await user.clear(input);
    await user.type(input, 'Two words{Enter}');

    // Space is the row's select shortcut and Enter starts a rename; neither may
    // fire while the field has focus, or the name becomes untypeable.
    expect(state().elements.byId[elements[0]?.id ?? '']?.name).toBe('Two words');
    expect(state().selection.size).toBe(0);
    expect(screen.queryByRole('textbox', { name: 'Layer name' })).not.toBeInTheDocument();
  });

  it('reverts on Escape and returns focus to the row', async () => {
    const user = userEvent.setup();
    const elements = seed(1);
    render(<LayersPanel />);

    await user.dblClick(screen.getByText('Layer 1'));
    await user.keyboard('nonsense{Escape}');

    expect(state().elements.byId[elements[0]?.id ?? '']?.name).toBe('Layer 1');
    expect(state().history.past).toHaveLength(0);
    expect(rows()[0]).toHaveFocus();
  });
});

describe('keyboard navigation', () => {
  it('moves between rows with the arrow keys and keeps one tab stop', async () => {
    const user = userEvent.setup();
    seed(3);
    render(<LayersPanel />);

    rows()[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expect(rows()[1]).toHaveFocus();

    await user.keyboard('{End}');
    expect(rows()[2]).toHaveFocus();

    await user.keyboard('{Home}');
    expect(rows()[0]).toHaveFocus();

    // Roving tabindex: exactly one row is reachable by Tab.
    expect(rows().filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('selects with Space', async () => {
    const user = userEvent.setup();
    const elements = seed(2);
    render(<LayersPanel />);

    rows()[0]?.focus();
    await user.keyboard(' ');

    expect([...state().selection]).toEqual([elements[1]?.id]);
  });

  it('reorders with Alt+Arrow as one undo entry', async () => {
    const user = userEvent.setup();
    const elements = seed(3);
    render(<LayersPanel />);

    rows()[0]?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    const [a, b, c] = elements.map((element) => element.id);
    // Display 3,2,1 → the top layer drops one place → paint order a, c, b.
    expect(state().elements.order).toEqual([a, c, b]);
    expect(state().history.past).toHaveLength(1);
  });
});

/**
 * Rows are `ROW_HEIGHT` tall and the list has `LAYER_LIST_PADDING` above the
 * first one, so a drop is addressed by row index plus the fraction of that row
 * the pointer is in. The outer quarters mean "beside"; the middle half means
 * "inside", on a group.
 */
const atRow = (index: number, zone: 'before' | 'into' | 'after'): number =>
  LAYER_LIST_PADDING + index * ROW_HEIGHT + (zone === 'before' ? 2 : zone === 'into' ? 16 : 30);

describe('drag to reorder', () => {
  it('moves a row past the one below it, in one undo entry', () => {
    stubRowGeometry();
    const elements = seed(3);
    render(<LayersPanel />);

    const top = rows()[0];
    if (top === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(top), { clientY: 8, button: 0 });
    fireEvent.pointerMove(window, { clientY: atRow(1, 'after') });
    fireEvent.pointerUp(window, { clientY: atRow(1, 'after') });

    const [a, b, c] = elements.map((element) => element.id);
    expect(state().elements.order).toEqual([a, c, b]);
    expect(state().history.past).toHaveLength(1);
  });

  it('shows a drop indicator while dragging and not before', () => {
    stubRowGeometry();
    seed(3);
    const { container } = render(<LayersPanel />);

    const top = rows()[0];
    if (top === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(top), { clientY: 8, button: 0 });
    expect(indicators(container)).toBe(0);

    fireEvent.pointerMove(window, { clientY: atRow(1, 'after') });
    expect(indicators(container)).toBe(1);

    fireEvent.pointerUp(window, { clientY: atRow(1, 'after') });
    expect(indicators(container)).toBe(0);
  });

  it('offers nothing, and records nothing, for a drop back where the row started', () => {
    // The gap it already occupies is not a move, and a no-op must not cost an
    // undo entry - so the indicator does not offer it in the first place.
    stubRowGeometry();
    const elements = seed(3);
    const { container } = render(<LayersPanel />);

    const top = rows()[0];
    if (top === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(top), { clientY: 8, button: 0 });
    fireEvent.pointerMove(window, { clientY: atRow(0, 'after') });
    expect(indicators(container)).toBe(0);

    fireEvent.pointerUp(window, { clientY: atRow(0, 'after') });
    expect(state().elements.order).toEqual(elements.map((element) => element.id));
    expect(state().history.past).toHaveLength(0);
  });

  it('ignores a press that never passes the drag threshold', () => {
    stubRowGeometry();
    const elements = seed(3);
    render(<LayersPanel />);

    const top = rows()[0];
    if (top === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(top), { clientY: 8, button: 0 });
    fireEvent.pointerMove(window, { clientY: 9 });
    fireEvent.pointerUp(window, { clientY: 9 });

    expect(state().elements.order).toEqual(elements.map((element) => element.id));
    expect(state().history.past).toHaveLength(0);
  });

  it('abandons the drag on Escape', () => {
    stubRowGeometry();
    const elements = seed(3);
    render(<LayersPanel />);

    const top = rows()[0];
    if (top === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(top), { clientY: 8, button: 0 });
    fireEvent.pointerMove(window, { clientY: 80 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { clientY: 80 });

    expect(state().elements.order).toEqual(elements.map((element) => element.id));
  });
});

describe('re-render discipline', () => {
  it('gives each row its own name cell, so a row can be found without the panel', () => {
    seed(2);
    render(<LayersPanel />);

    const row = rows()[0];
    if (row === undefined) throw new Error('fixture');
    expect(within(row).getByText('Layer 2')).toBeInTheDocument();
  });

  it('keeps mixed element types distinguishable', () => {
    state().addElements([
      createRectangle(worldRect(0, 0, 10, 10), { name: 'Box' }),
      createEllipse(worldRect(0, 0, 10, 10), { name: 'Blob' }),
    ]);
    render(<LayersPanel />);

    expect(rows().map((row) => row.textContent)).toEqual(['Blob', 'Box']);
  });
});

/*
 * Virtualization.
 *
 * These tests have to fight jsdom a little, and the reason is worth stating:
 * jsdom has no layout, so every element reports `clientHeight === 0`. The
 * windowing hook treats an unmeasured container as "render everything", which
 * is the safe fallback - but it also means that without the stub below, every
 * test here exercises the unvirtualized path and proves nothing about the
 * feature. Stubbing the viewport height is what makes these real.
 *
 * Nothing waits on a fixed duration. The hook coalesces its measurement onto a
 * frame, and a first draft of this block slept 40ms for it - which passed alone
 * and failed under a loaded parallel suite, the same wall-clock flakiness this
 * repo already removed from the perf benchmark. `waitFor` polls the condition
 * instead, so the tests are as slow as the machine needs and no slower.
 */
function stubViewportHeight(height: number): void {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
}

const grid = (): HTMLElement => screen.getByRole('treegrid');

/** Resolves once the hook has measured and the window is smaller than the list. */
async function waitForWindow(total: number): Promise<void> {
  await waitFor(() => {
    expect(rows().length).toBeLessThan(total);
  });
}

/** 200 rows in a 320px viewport: ten visible, six overscan each side. */
const TOTAL = 200;
const VIEWPORT = 320;

describe('layers panel virtualization', () => {
  it('renders only a window of rows, not the whole document', async () => {
    seed(TOTAL);
    stubViewportHeight(VIEWPORT);
    render(<LayersPanel />);

    await waitForWindow(TOTAL);
    expect(rows().length).toBeGreaterThan(9);
    expect(rows().length).toBeLessThan(40);
  });

  it('still tells assistive technology how long the real list is', async () => {
    seed(TOTAL);
    stubViewportHeight(VIEWPORT);
    render(<LayersPanel />);
    await waitForWindow(TOTAL);

    // Without `aria-rowcount` and `aria-rowindex` a screen reader would report
    // the rendered window as the entire document - the accessibility regression
    // that makes naive virtualization worse than none.
    //
    // The count is *visible rows*, which here is every element because nothing
    // is grouped. A collapsed group's members are absent from the row list and
    // unreachable by arrow key, so counting them would misreport the length of
    // the list a screen reader can actually move through.
    expect(grid()).toHaveAttribute('aria-rowcount', String(TOTAL));
    expect(rows()[0]).toHaveAttribute('aria-rowindex', '1');
  });

  it('renders a different window after scrolling, with correct row indices', async () => {
    seed(TOTAL);
    stubViewportHeight(VIEWPORT);
    render(<LayersPanel />);
    await waitForWindow(TOTAL);

    // Display index 0 is the topmost layer, which is the last one added.
    expect(screen.getByText(`Layer ${TOTAL}`)).toBeInTheDocument();

    const container = grid();
    container.scrollTop = 100 * ROW_HEIGHT;
    fireEvent.scroll(container);

    // Display index 100 is `Layer (TOTAL - 100)`; the list is top-first.
    await screen.findByText(`Layer ${TOTAL - 100}`);
    expect(screen.queryByText(`Layer ${TOTAL}`)).not.toBeInTheDocument();

    const index = Number(rows()[0]?.getAttribute('aria-rowindex') ?? '0');
    expect(index).toBeGreaterThan(90);
  });

  it('reserves the full scroll height so the scrollbar reflects the document', async () => {
    seed(TOTAL);
    stubViewportHeight(VIEWPORT);
    const { container } = render(<LayersPanel />);
    await waitForWindow(TOTAL);

    const sizer = container.querySelector<HTMLElement>('[role="treegrid"] > div');
    expect(sizer?.style.height).toBe(`${TOTAL * ROW_HEIGHT + 8}px`);
  });

  it('renders every row when the container has not been measured', () => {
    // The fallback, and the path jsdom takes by default. Asserted so the
    // degradation stays a decision rather than an accident.
    seed(30);
    render(<LayersPanel />);
    expect(rows()).toHaveLength(30);
  });

  it('scrolls a row into view when focus moves past the window edge', async () => {
    seed(TOTAL);
    stubViewportHeight(VIEWPORT);
    render(<LayersPanel />);
    await waitForWindow(TOTAL);

    const container = grid();
    expect(container.scrollTop).toBe(0);

    // End targets the last row, which has never been rendered.
    const first = rows()[0];
    first?.focus();
    fireEvent.keyDown(first as HTMLElement, { key: 'End' });

    await screen.findByText('Layer 1'); // display index TOTAL - 1
    expect(container.scrollTop).toBeGreaterThan(0);
  });
});

/*
 * The tree.
 *
 * A group is one row with a disclosure triangle; its members are indented rows
 * beneath it, in the same flat, fixed-height array everything above windows.
 */
const twisty = (row: HTMLElement): HTMLElement => {
  const button = row.querySelector<HTMLElement>('[data-layer-twisty]');
  if (button === null) throw new Error('row has no twisty');
  return button;
};

/** Two rectangles collected into a group, with a third left at the root. */
function seedGroup(): { groupId: string; members: string[]; loose: string } {
  const elements = seed(3);
  const ids = elements.map((element) => element.id);
  const [a, b, c] = ids;
  if (a === undefined || b === undefined || c === undefined) throw new Error('fixture');
  const groupId = state().group([b, c]);
  if (groupId === null) throw new Error('grouping refused');
  useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
  return { groupId, members: [b, c], loose: a };
}

/**
 * `seedGroup`, plus a fourth element left un-grouped above the group - a row
 * with no relation to the group's subtree, safe to drag anywhere in the list
 * without tripping the "into its own subtree" refusal. Rows display, top to
 * bottom: dragger, group, member, member, loose.
 */
function seedGroupWithDragger(): {
  dragger: string;
  groupId: string;
  members: string[];
  loose: string;
} {
  const elements = seed(4);
  const ids = elements.map((element) => element.id);
  const [a, b, c, d] = ids;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error('fixture');
  }
  const groupId = state().group([b, c]);
  if (groupId === null) throw new Error('grouping refused');
  useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
  return { dragger: d, groupId, members: [b, c], loose: a };
}

describe('the tree', () => {
  it('indents members under their group and levels them for assistive technology', () => {
    seedGroup();
    render(<LayersPanel />);

    // Display is top-first: the group is above the loose rectangle it was
    // lifted out of, and its members hang below it.
    expect(rows().map((row) => row.getAttribute('aria-level'))).toEqual(['1', '2', '2', '1']);
    expect(rows()[0]).toHaveAttribute('aria-expanded', 'true');
    // Leaves have nothing to disclose, so they say nothing about it.
    expect(rows()[1]).not.toHaveAttribute('aria-expanded');
  });

  it('drops the members from the list when the group is collapsed', async () => {
    const user = userEvent.setup();
    seedGroup();
    render(<LayersPanel />);

    await user.click(twisty(rows()[0] as HTMLElement));

    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveAttribute('aria-expanded', 'false');
    // Not merely hidden: a collapsed group's members are not navigable, so the
    // announced length of the list has to shrink with them.
    expect(grid()).toHaveAttribute('aria-rowcount', '2');
  });

  it('collapsing is view state and never reaches history', async () => {
    const user = userEvent.setup();
    seedGroup();
    render(<LayersPanel />);

    await user.click(twisty(rows()[0] as HTMLElement));

    expect(state().history.past).toHaveLength(0);
  });

  it('never parks focus on the twisty, which is aria-hidden', async () => {
    // A focusable node inside an `aria-hidden` subtree is the axe
    // `aria-hidden-focus` violation: Chrome and Firefox focus a `<button>` on
    // mousedown regardless of `tabIndex`, so the triangle has to be something
    // that cannot receive focus at all rather than a hidden, unreachable one.
    const user = userEvent.setup();
    seedGroup();
    render(<LayersPanel />);

    const triangle = twisty(rows()[0] as HTMLElement);
    expect(triangle.tagName).toBe('SPAN');
    expect(triangle).not.toHaveAttribute('tabindex');

    await user.click(triangle);

    expect(document.activeElement).not.toBe(triangle);
  });

  it('opens and descends with ArrowRight, closes and ascends with ArrowLeft', async () => {
    const user = userEvent.setup();
    seedGroup();
    render(<LayersPanel />);

    rows()[0]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(rows()).toHaveLength(2);

    await user.keyboard('{ArrowRight}');
    expect(rows()).toHaveLength(4);

    // Open already, so the second press steps into the first child.
    await user.keyboard('{ArrowRight}');
    expect(rows()[1]).toHaveFocus();

    // A member is not a group, so Left leaves it for its parent.
    await user.keyboard('{ArrowLeft}');
    expect(rows()[0]).toHaveFocus();
  });

  it('keeps a member selectable by clicking its row', async () => {
    const user = userEvent.setup();
    const { members } = seedGroup();
    render(<LayersPanel />);

    await user.click(rows()[1] as HTMLElement);

    // The topmost member is the last one in the group's `childIds`.
    expect([...state().selection]).toEqual([members[1]]);
  });

  it('unfolds a collapsed group when something inside it is selected elsewhere', async () => {
    const user = userEvent.setup();
    const { members } = seedGroup();
    render(<LayersPanel />);

    await user.click(twisty(rows()[0] as HTMLElement));
    expect(rows()).toHaveLength(2);

    // Stands in for entering the group on the canvas and clicking a member:
    // there is no row to highlight until the group opens, so it opens.
    act(() => {
      state().select([members[0] ?? '']);
    });

    expect(rows()).toHaveLength(4);
    expect(rows().find((row) => row.getAttribute('aria-selected') === 'true')).toBeDefined();
  });

  it('shows a member as hidden when its group is, without touching its own flag', async () => {
    const user = userEvent.setup();
    const { groupId, members } = seedGroup();
    render(<LayersPanel />);

    await user.click(screen.getByRole('button', { name: `Hide ${state().elements.byId[groupId]?.name ?? ''}` }));

    const memberRow = rows()[1];
    expect(memberRow?.className).toContain('opacity-55');
    // The member's own flag is untouched - it is inside something hidden, not
    // hidden itself, and flattening that would survive the group being shown.
    expect(state().elements.byId[members[1] ?? '']?.visible).toBe(true);
    // And its own control says so rather than offering an action that would do
    // nothing visible.
    expect(within(memberRow as HTMLElement).getByRole('button', { name: /hidden by its group/ })).toBeDisabled();
  });

  it('reports a member as locked by its group', async () => {
    const user = userEvent.setup();
    const { groupId, members } = seedGroup();
    render(<LayersPanel />);

    await user.click(screen.getByRole('button', { name: `Lock ${state().elements.byId[groupId]?.name ?? ''}` }));

    expect(state().elements.byId[members[1] ?? '']?.locked).toBe(false);
    const control = within(rows()[1] as HTMLElement).getByRole('button', {
      name: /locked by its group/,
    });
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('aria-pressed', 'true');
  });

  it('refuses to reorder a member as though its row were a root position', async () => {
    // A member's display index says nothing about a position in `elements.order`.
    // Dragging can move a row between levels - it resolves to a parent and an
    // index - but Alt+Arrow still speaks only about the root order, so a member
    // stays put under it rather than being moved somewhere arithmetic pointed.
    const user = userEvent.setup();
    seedGroup();
    render(<LayersPanel />);
    const before = state().elements.order;

    rows()[1]?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(state().elements.order).toBe(before);
    expect(state().history.past).toHaveLength(0);
  });

  it('still reorders root rows, counting only the rows that are root rows', async () => {
    const user = userEvent.setup();
    const { groupId, loose } = seedGroup();
    render(<LayersPanel />);

    // Display is group, member, member, loose. Alt+Down on the group has to
    // skip its own members and land below the loose rectangle.
    rows()[0]?.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(state().elements.order).toEqual([groupId, loose]);
    expect(state().history.past).toHaveLength(1);
  });
});

/*
 * Rows are group, member, member, loose - see `seedGroup`. A drop is a parent
 * and an index rather than a slot, so these check the two directions across a
 * level boundary, the refusal that keeps the tree a tree, and that each drop
 * costs exactly one undo entry however many lists it rewrites.
 */
describe('drag to reparent', () => {
  it('lifts a member out of its group, in one undo entry', () => {
    stubRowGeometry();
    const { groupId, members, loose } = seedGroup();
    render(<LayersPanel />);

    const member = rows()[2];
    if (member === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(member), { clientY: atRow(2, 'into'), button: 0 });
    fireEvent.pointerMove(window, { clientY: atRow(0, 'before') });
    fireEvent.pointerUp(window, { clientY: atRow(0, 'before') });

    // Above the topmost row is the *end* of the bottom-to-top root order.
    expect(state().elements.order).toEqual([loose, groupId, members[0]]);
    expect(state().elements.byId[groupId]).toMatchObject({ childIds: [members[1]] });
    // Leaving one list and joining another is two writes and one transaction.
    expect(state().history.past).toHaveLength(1);
  });

  it('drops a root row into a group, at the top of its members', () => {
    stubRowGeometry();
    const { groupId, members, loose } = seedGroup();
    render(<LayersPanel />);

    const row = rows()[3];
    if (row === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(row), { clientY: atRow(3, 'into'), button: 0 });
    fireEvent.pointerMove(window, { clientY: atRow(0, 'into') });
    fireEvent.pointerUp(window, { clientY: atRow(0, 'into') });

    // The visual top of a group is the end of its childIds.
    expect(state().elements.byId[groupId]).toMatchObject({ childIds: [...members, loose] });
    expect(state().elements.order).toEqual([groupId]);
    expect(state().history.past).toHaveLength(1);
  });

  it('refuses to drop a group inside its own subtree, and offers no line for it', () => {
    // A group inside its own descendant stops the tree being a tree, and every
    // recursive walk over it would then depend on a visited set to terminate.
    stubRowGeometry();
    seedGroup();
    const { container } = render(<LayersPanel />);
    const before = state().elements;

    const group = rows()[0];
    if (group === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(group), { clientY: atRow(0, 'into'), button: 0 });
    fireEvent.pointerMove(window, { clientY: atRow(1, 'before') });
    expect(indicators(container)).toBe(0);

    fireEvent.pointerUp(window, { clientY: atRow(1, 'before') });
    expect(state().elements).toBe(before);
    expect(state().history.past).toHaveLength(0);
  });

  it('rings the group a drop would land inside, rather than drawing a line', () => {
    stubRowGeometry();
    seedGroup();
    const { container } = render(<LayersPanel />);

    const row = rows()[3];
    if (row === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(row), { clientY: atRow(3, 'into'), button: 0 });
    fireEvent.pointerMove(window, { clientY: atRow(0, 'into') });

    // One indicator, and it is the ring on the group rather than a rule in a gap.
    expect(indicators(container)).toBe(1);
    expect(rows()[0]?.querySelector('[data-drop-indicator]')?.className).toContain('ring-accent');
  });

  it('unfolds a collapsed group it is dropped into, so the row is still visible', async () => {
    const user = userEvent.setup();
    const { groupId, loose } = seedGroup();
    render(<LayersPanel />);

    await user.click(twisty(rows()[0] as HTMLElement));
    expect(rows()).toHaveLength(2);

    stubRowGeometry();
    const row = rows()[1];
    if (row === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(row), { clientY: atRow(1, 'into'), button: 0 });
    fireEvent.pointerMove(window, { clientY: atRow(0, 'into') });
    fireEvent.pointerUp(window, { clientY: atRow(0, 'into') });

    // Folding is how a big group gets out of the way, so it stays a drop
    // target - but a member of a folded group has no row at all, and leaving
    // it folded would read as the row having vanished.
    expect((state().elements.byId[groupId] as GroupElement).childIds).toContain(loose);
    expect(state().collapsedGroupIds.has(groupId)).toBe(false);
    expect(rows()).toHaveLength(4);
  });

  it("indents the drop line by the hovered row's depth, so a member's gap and the root gap one row below it look different", () => {
    // Rows: dragger, g1, member, member(m2), loose - g1's gap below m2 and the
    // root's gap above `loose` are one pixel apart and, before this fix, drew
    // the identical full-width rule: the one fact this indicator exists to
    // show - which level the drop lands at - was invisible.
    stubRowGeometry();
    seedGroupWithDragger();
    render(<LayersPanel />);

    const dragger = rows()[0];
    if (dragger === undefined) throw new Error('fixture');
    fireEvent.pointerDown(grip(dragger), { clientY: atRow(0, 'into'), button: 0 });

    // "After m2" (row 3, depth 1) - lands inside the group.
    fireEvent.pointerMove(window, { clientY: atRow(3, 'after') });
    const nestedLine = rows()[3]?.querySelector<HTMLElement>('[data-drop-indicator]');
    expect(nestedLine?.style.left).toBe(`${1 * LAYER_INDENT_PX + LAYER_ROW_INSET_PX}px`);

    // "Before loose" (row 4, depth 0) - lands in the root order instead.
    fireEvent.pointerMove(window, { clientY: atRow(4, 'before') });
    const rootLine = rows()[4]?.querySelector<HTMLElement>('[data-drop-indicator]');
    expect(rootLine?.style.left).toBe(`${0 * LAYER_INDENT_PX + LAYER_ROW_INSET_PX}px`);

    expect(nestedLine?.style.left).not.toBe(rootLine?.style.left);

    fireEvent.pointerUp(window, { clientY: atRow(4, 'before') });
  });
});

describe('row height contract', () => {
  it('matches the CSS class the row actually uses', () => {
    // The hook multiplies by LAYER_ROW_HEIGHT; the row is sized by `h-8`. If one
    // changes without the other every scroll position drifts - silently, and
    // worse the further down the list you go.
    seed(1);
    render(<LayersPanel />);
    expect(rows()[0]?.className).toContain('h-8');
    expect(LAYER_ROW_HEIGHT).toBe(32);
  });
});

describe('following a selection made elsewhere', () => {
  it('scrolls a selected row into view when the selection comes from the canvas', async () => {
    seed(TOTAL);
    stubViewportHeight(VIEWPORT);
    render(<LayersPanel />);
    await waitForWindow(TOTAL);

    const container = grid();
    expect(container.scrollTop).toBe(0);

    // Select an element deep in the list the way the canvas does - through the
    // store, not through the panel.
    const deep = state().elements.order[10];
    act(() => {
      state().select([deep!]);
    });

    // Display order is top-first, so document index 10 is near the bottom.
    // The window re-measures on a frame, so wait for the row itself rather than
    // for the scroll offset that precedes it.
    await waitFor(() => {
      expect(rows().find((row) => row.getAttribute('aria-selected') === 'true')).toBeDefined();
    });
    expect(container.scrollTop).toBeGreaterThan(0);
  });

  it('does not scroll for a selection made by clicking a row', async () => {
    // The regression this guards: clicking a row also begins a possible reorder
    // drag, and scrolling the list underneath it drops the row at the wrong
    // index. A row that was just clicked is already in view regardless.
    seed(TOTAL);
    stubViewportHeight(VIEWPORT);
    render(<LayersPanel />);
    await waitForWindow(TOTAL);

    const container = grid();
    container.scrollTop = 40 * ROW_HEIGHT;
    fireEvent.scroll(container);
    await waitFor(() => {
      expect(Number(rows()[0]?.getAttribute('aria-rowindex'))).toBeGreaterThan(30);
    });

    const before = container.scrollTop;
    fireEvent.pointerDown(rows()[2] as HTMLElement, { button: 0 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.scrollTop).toBe(before);
  });

  it('does not write scrollTop until the taller, expanded list has been laid out', async () => {
    // Regression for the clamp: `expandAncestorsOf` and the scroll used to run
    // in the same tick, against the DOM's *pre-expansion* sizer height. A real
    // browser clamps `scrollTop` to `scrollHeight - clientHeight`, so revealing
    // a big collapsed group could scroll short of the very row it was meant to
    // reveal. jsdom has no layout and cannot reproduce the clamp itself - what
    // this proves instead is the ordering that prevents it: by the time
    // scrollTop is written, the sizer already reports the *expanded* height,
    // never the collapsed one the effect started with.
    const elements = seed(30);
    const memberIds = elements.slice(0, 20).map((element) => element.id);
    const groupId = state().group(memberIds);
    if (groupId === null) throw new Error('grouping refused');
    useCanvasStore.setState({ history: { past: [], future: [], depth: 0, pending: null } });
    act(() => {
      state().toggleGroupCollapsed(groupId);
    });

    const { container } = render(<LayersPanel />);
    const sizer = (): string | undefined =>
      container.querySelector<HTMLElement>('[role="treegrid"] > div')?.style.height;

    // 1 group row + the 10 loose rows left at the root.
    const collapsedHeight = `${11 * ROW_HEIGHT + 8}px`;
    // Every one of the 31 elements gets a row once the group is open.
    const expandedHeight = `${31 * ROW_HEIGHT + 8}px`;
    expect(sizer()).toBe(collapsedHeight);

    // An own property on this one node, shadowing the prototype's accessor -
    // real behaviour is preserved (reads see what was last written) while
    // every write is recorded against the sizer height at that instant.
    const treegrid = grid();
    const heightsAtWrite: (string | undefined)[] = [];
    let scrollTopValue = treegrid.scrollTop;
    Object.defineProperty(treegrid, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (next: number) => {
        heightsAtWrite.push(sizer());
        scrollTopValue = next;
      },
    });

    // Stands in for selecting a deeply-nested member from the canvas - the
    // same trigger `expandAncestorsOf` exists for.
    act(() => {
      state().select([memberIds[0] ?? '']);
    });

    await waitFor(() => {
      expect(rows().find((row) => row.getAttribute('aria-selected') === 'true')).toBeDefined();
    });

    expect(heightsAtWrite.length).toBeGreaterThan(0);
    expect(heightsAtWrite.every((height) => height === expandedHeight)).toBe(true);
  });
});
