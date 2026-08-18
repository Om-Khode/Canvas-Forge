import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Layers } from 'lucide-react';

import { EmptyState, Panel } from '@/components/common';
import { LAYER_LIST_PADDING, LAYER_OVERSCAN, LAYER_ROW_HEIGHT } from '@/constants';
import { planDrop } from './dropTarget';
import type { DropPlan } from './dropTarget';
import { LayerRow, type SelectModifiers } from './LayerRow';
import { rootStepTarget, selectLayerRows } from './layerRows';
import type { LayerRow as LayerRowData } from './layerRows';
import { useLayerFocus } from './useLayerFocus';
import { useLayerReorder } from './useLayerReorder';
import { useVirtualRows } from './useVirtualRows';
import { useCanvasStore } from '@/store/index';
import type { ElementId } from '@/types';
import { cn } from '@/utils/cn';

export interface LayersPanelProps {
  className?: string;
}

/**
 * The document, as a tree.
 *
 * This panel is the canvas's accessible counterpart: canvas pixels are not
 * reachable by a screen reader, and rather than pretend otherwise the editor
 * gives every element a named, focusable, operable row here
 * (docs/architecture.md#12). That is why it is a real treegrid with roving focus
 * and keyboard reordering rather than a decorative list of labels.
 *
 * **Elements are listed top-first**, the reverse of `elementOrder`, which runs
 * bottom-to-top because that is paint order. Users think about depth the other
 * way round - the thing in front is at the top of the list - so exactly one
 * place performs the flip (`layerRows.ts`) and everything downstream speaks
 * display indices.
 *
 * **A group is one row and its members are indented rows beneath it**, and the
 * tree is flattened before it gets here: `rows` is a flat array of fixed-height
 * rows, so nesting changed the row model and touched none of the machinery
 * below it. See `layerRows.ts` for why that constraint is not negotiable.
 *
 * **Only the visible rows exist.** Rendering all of them cost 979ms and 45,221
 * nodes at 2,000 elements (`docs/performance.md`), and the node count made
 * unrelated style writes elsewhere on the page expensive too. Windowing is
 * cheap here because every row is exactly `LAYER_ROW_HEIGHT` tall, so the
 * visible range is arithmetic. Three things had to be kept honest across the
 * change, and each is handled rather than quietly dropped: focus can target a
 * row that is not in the DOM (`useLayerFocus`), `aria-rowindex` becomes
 * mandatory once the DOM no longer holds the whole list (`LayerRow`), and
 * drag-reorder can no longer measure rows it cannot see (`useLayerReorder`).
 */
export function LayersPanel({ className }: LayersPanelProps) {
  // Narrow by construction: the selector returns the *same* array while the
  // tree's shape is unchanged, so a canvas drag - which patches an element on
  // every pointermove - re-renders this panel zero times.
  const rows = useCanvasStore(selectLayerRows);

  const listRef = useRef<HTMLDivElement | null>(null);
  /*
    The element is held in state *as well as* a ref. The ref is what the stable
    handlers reach through; the state is what lets the windowing effect re-bind
    when the node is replaced - which happens every time the list goes empty and
    back, as it does on project load. A ref alone silently left the listeners on
    a detached div.
  */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const attachList = useCallback((element: HTMLDivElement | null): void => {
    listRef.current = element;
    setListEl(element);
  }, []);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [renamingId, setRenamingId] = useState<ElementId | null>(null);
  /** Shift-click extends from here - the last row picked without Shift. */
  const anchorRef = useRef<number | null>(null);

  const { remeasure, ...window_ } = useVirtualRows({
    count: rows.length,
    rowHeight: LAYER_ROW_HEIGHT,
    overscan: LAYER_OVERSCAN,
    container: listEl,
  });

  /*
    Handlers below are stable for the panel's lifetime so the memoized rows are
    not invalidated on every render. They reach the current list through a ref
    rather than closing over `rows`.
  */
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });

  const { scrollIndexIntoView, focusRow, focusRowAfterRender } = useLayerFocus(listRef, remeasure);

  /*
    Follow a selection made somewhere else.

    Selecting on the canvas used to leave the panel where it was. That was
    survivable while every row existed in the DOM - the highlighted row was at
    least there to be scrolled to - and stopped being survivable once the list
    virtualized, because a row outside the window is not rendered at all and the
    selection became invisible in the panel entirely.

    Keyed on the selection's identity, so it runs when the selection changes and
    not when the list scrolls. Clicking a row is already in view, so this is a
    no-op for selections made here; it only moves for ones made elsewhere.
  */
  const selection = useCanvasStore((state) => state.selection);
  /*
    Set by this panel's own `select`, and cleared by the effect below.

    Without it the scroll fires for selections made *here* too, and that is not
    merely redundant - pressing a row selects it, so the scroll ran in the middle
    of a reorder drag, moved the list under the pointer, and the row dropped at
    the wrong index. A row you just clicked is by definition already in view, so
    the only selections worth following are the ones from somewhere else.
  */
  const selectedHere = useRef(false);
  /*
    A row waiting to be scrolled to, set by the effect below and consumed by
    the layout effect that follows it.

    Split into two effects because `expandAncestorsOf` can grow `rows`, and the
    scroll container's sizer only reports the *taller* scroll height once React
    has re-rendered and the browser has laid out that growth. A store write and
    the render it causes are two separate, unordered ticks: calling
    `scrollIndexIntoView` in the same tick as `expandAncestorsOf` - as a single
    effect did before - measured the DOM's *pre-expansion* sizer height, which a
    real browser clamps `scrollTop` against. Unfolding a big collapsed group
    could then still scroll short of the very row this effect exists to reveal.
    `useLayoutEffect`, keyed on `rows.length` as well as the pending index,
    fires after the taller render has actually committed, and only then reads
    the real layout.

    (Tried first: forcing the write and its render to finish synchronously with
    `flushSync` in one effect. React warns and declines - a passive effect is
    already inside its own commit's effect-flush cycle, which is exactly the
    "already rendering" `flushSync` refuses to interrupt. Two effects, not one
    forced one, is the supported way to sequence this.)
  */
  const [pendingFollowIndex, setPendingFollowIndex] = useState<number | null>(null);
  useEffect(() => {
    if (selectedHere.current) {
      selectedHere.current = false;
      return;
    }
    if (selection.size === 0) return;

    /*
      Unfold first, then look.

      A selection inside a collapsed group has no row at all - that is what
      collapsing means here, the members are absent from the list rather than
      hidden in it - so there would be nothing to scroll to and nothing
      highlighted. Revealing beats highlighting the closed ancestor instead:
      the ancestor is not what is selected, `aria-selected` on it would be
      false, and the panel's job is to show *what is selected*.

      The store write means the rows this effect can see are already stale, so
      the index is taken from freshly built ones. React renders them a moment
      later; the scroll position is what has to be right once that render is
      laid out, which is the layout effect's job, not this one's.
    */
    useCanvasStore.getState().expandAncestorsOf([...selection]);
    const nextRows = selectLayerRows(useCanvasStore.getState());
    // The topmost selected row, which is the one a user scanning the list
    // expects to be taken to.
    const index = nextRows.findIndex((row) => selection.has(row.id));
    if (index === -1) return;
    // Synchronizing with an external system (the store) by handing its result
    // to a later effect, not deriving state from props - the pattern the rule
    // this silences is meant to catch. See the block comment above: the two
    // effects exist because the scroll cannot be measured until a *second*,
    // later commit, and this is what schedules that commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingFollowIndex(index);
  }, [selection]);

  useLayoutEffect(() => {
    if (pendingFollowIndex === null) return;
    scrollIndexIntoView(pendingFollowIndex);
    // Clears the request this same effect just served; see the block comment
    // above for why this is deliberate and not the antipattern the rule below
    // is written to catch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingFollowIndex(null);
    // `rows.length` is what makes this run again once an expansion's taller
    // render has committed - this effect fires after every commit, including
    // the one still in flight when `pendingFollowIndex` was first set, and it
    // is that later commit's DOM the scroll has to be measured against.
  }, [pendingFollowIndex, rows.length, scrollIndexIntoView]);

  /*
    A drop is a parent and an index, not a slot.

    The rows are a tree, so the same visual gap can mean several parents;
    `dropTarget.ts` turns the row plus the offset within it into one landing
    place, and returns null for the drops that must be refused - into the
    dragged row's own subtree, or back where it already was. The hook draws an
    indicator only where there is a plan, so every line the panel shows is a
    place the drop really lands.
  */
  const reorder = useLayerReorder({
    containerRef: listRef,
    rowHeight: LAYER_ROW_HEIGHT,
    count: rows.length,
    plan: useCallback(
      (id: ElementId, fromIndex: number, rowIndex: number, offsetInRow: number) =>
        planDrop(rowsRef.current, id, fromIndex, rowIndex, offsetInRow, LAYER_ROW_HEIGHT),
      []
    ),
    onDrop: useCallback((id: ElementId, plan: DropPlan): void => {
      const store = useCanvasStore.getState();
      const moved = store.reparent(id, plan.parentId, plan.index);
      // Unfold what the row just joined - but only once it actually joined.
      // `reparent` and `planDrop` agree today, so this is order-of-operations
      // hygiene rather than a live bug: if the write were ever declined, the
      // reason to unfold (the row *arrived*) would not hold, and unfolding
      // first would leave a group open for a move that never happened.
      if (moved && plan.zone === 'into' && plan.parentId !== null) {
        store.setGroupCollapsed(plan.parentId, false);
      }
    }, []),
  });

  const select = useCallback((index: number, modifiers: SelectModifiers): void => {
    const list = rowsRef.current;
    const id = list[index]?.id;
    if (id === undefined) return;
    selectedHere.current = true;
    const store = useCanvasStore.getState();
    const anchor = anchorRef.current;

    if (modifiers.shiftKey && anchor !== null) {
      // Range select, like a file list. The anchor stays put so repeated
      // shift-clicks grow and shrink the same range instead of ratcheting.
      // A range that spans a group and its own members is not a special case:
      // the selection slice drops the nested ids (`withoutNestedIds`).
      const from = Math.min(anchor, index);
      const to = Math.max(anchor, index);
      store.select(list.slice(from, to + 1).map((row) => row.id));
    } else if (modifiers.metaKey || modifiers.ctrlKey) {
      store.toggle(id);
      anchorRef.current = index;
    } else {
      store.select([id]);
      anchorRef.current = index;
    }
    setFocusedIndex(index);
  }, []);

  const moveFocus = useCallback(
    (index: number): void => {
      const clamped = Math.min(Math.max(index, 0), rowsRef.current.length - 1);
      setFocusedIndex(clamped);
      focusRow(clamped);
    },
    [focusRow]
  );

  const toggleCollapse = useCallback((id: ElementId): void => {
    useCanvasStore.getState().toggleGroupCollapsed(id);
  }, []);

  /**
   * ArrowRight / ArrowLeft, the treegrid pattern.
   *
   * Right opens a closed group and steps into an open one; Left closes an open
   * group and steps out of anything else. Both are no-ops at the ends, which is
   * what makes them safe to hold down.
   */
  const handleHorizontal = useCallback(
    (row: LayerRowData, index: number, direction: 1 | -1): void => {
      if (direction === 1) {
        if (!row.hasChildren) return;
        if (!row.expanded) toggleCollapse(row.id);
        else moveFocus(index + 1);
        return;
      }

      if (row.hasChildren && row.expanded) {
        toggleCollapse(row.id);
        return;
      }
      if (row.parentId === null) return;
      const parentIndex = rowsRef.current.findIndex((candidate) => candidate.id === row.parentId);
      if (parentIndex !== -1) moveFocus(parentIndex);
    },
    [moveFocus, toggleCollapse]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
      const list = rowsRef.current;
      const row = list[index];
      const vertical = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;

      // Alt+Arrow reorders. Drag needs a pointer; this is the same operation
      // for anyone who does not have one, and it commits through the same
      // single `moveToIndex` call, so it is likewise one undo entry.
      if (vertical !== 0 && event.altKey) {
        event.preventDefault();
        if (row === undefined) return;
        const target = rootStepTarget(list, row.id, vertical);
        if (target === null) return;
        useCanvasStore.getState().moveToIndex(row.id, target);
        // The rows the move produced, not the ones it replaced: the id's new
        // display index is not `index + vertical` once groups occupy rows of
        // their own.
        const moved = selectLayerRows(useCanvasStore.getState()).findIndex(
          (candidate) => candidate.id === row.id
        );
        if (moved === -1) return;
        setFocusedIndex(moved);
        focusRowAfterRender(moved);
        return;
      }

      if (vertical !== 0) {
        event.preventDefault();
        moveFocus(index + vertical);
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        if (row !== undefined) handleHorizontal(row, index, event.key === 'ArrowRight' ? 1 : -1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        moveFocus(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        moveFocus(list.length - 1);
      } else if (event.key === 'PageDown' || event.key === 'PageUp') {
        // A page is what the viewport shows, so the keyboard covers a long list
        // at the same rate the scrollbar does.
        event.preventDefault();
        const page = Math.max(
          1,
          Math.floor((listRef.current?.clientHeight ?? 0) / LAYER_ROW_HEIGHT) - 1
        );
        moveFocus(index + (event.key === 'PageDown' ? page : -page));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (row !== undefined) setRenamingId(row.id);
      } else if (event.key === ' ') {
        // Space selects; Enter is taken by rename, which is the convention in
        // every layers panel users arrive here from.
        event.preventDefault();
        select(index, event);
      }
    },
    [focusRowAfterRender, handleHorizontal, moveFocus, select]
  );

  const endRename = useCallback((): void => {
    setRenamingId(null);
  }, []);

  const rovingIndex = Math.min(focusedIndex, Math.max(rows.length - 1, 0));
  const visible = rows.slice(window_.start, window_.end);
  const drop = reorder.dropPlan;

  return (
    <Panel as="aside" title="Layers" scroll={false} className={cn('w-64', className)}>
      {rows.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No layers yet"
          description="Draw something on the canvas and it will appear here."
        />
      ) : (
        <div
          ref={attachList}
          role="treegrid"
          aria-label="Layers"
          aria-multiselectable="true"
          // Mandatory now that the DOM holds a window rather than the list: it
          // and `aria-rowindex` are the only things telling a screen reader
          // that row 7 of 2,000 is row 7 of 2,000.
          //
          // It counts *visible* rows, not every element. A collapsed group's
          // members are absent from `rows` entirely and cannot be reached by
          // arrow key, so counting them would tell a screen reader the list is
          // longer than anything it can move through.
          aria-rowcount={rows.length}
          className="h-full overflow-y-auto overscroll-contain"
        >
          <div style={{ height: window_.totalHeight + LAYER_LIST_PADDING * 2 }} className="relative">
            <div
              className="absolute inset-x-0"
              style={{ top: window_.offsetTop + LAYER_LIST_PADDING }}
            >
              {visible.map((row, offset) => {
                const index = window_.start + offset;
                return (
                  <LayerRow
                    // The element id, not the row position: a key that moved as
                    // siblings folded and unfolded would remount rows for no
                    // reason and lose focus mid-navigation.
                    key={row.id}
                    row={row}
                    index={index}
                    focused={index === rovingIndex}
                    renaming={renamingId === row.id}
                    dragging={reorder.draggingId === row.id}
                    dropBefore={drop?.rowIndex === index && drop.zone === 'before'}
                    dropInto={drop?.rowIndex === index && drop.zone === 'into'}
                    dropAfter={drop?.rowIndex === index && drop.zone === 'after'}
                    onSelect={select}
                    onFocusRow={setFocusedIndex}
                    onKeyDown={handleKeyDown}
                    onRenameStart={setRenamingId}
                    onRenameEnd={endRename}
                    onGripDown={reorder.begin}
                    onToggleCollapse={toggleCollapse}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
