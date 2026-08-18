/**
 * The layers panel's row model.
 *
 * The panel is fixed-height row virtualized, and that is not a detail to work
 * around - it is what took the list from 45,231 DOM nodes to 538
 * (`docs/performance.md`). Windowing is arithmetic only while every row is the
 * same height and the rows form one flat array, so nesting is not allowed to
 * introduce a container per group or a taller row for a group header. It is
 * expressed here instead: the tree is *flattened* into rows carrying a `depth`,
 * and depth becomes indentation, which costs nothing vertically.
 *
 * Everything downstream - the windowing maths, auto-scroll, the drag slot, the
 * roving tab stop - keeps speaking in row indices and needs no notion of a tree.
 */

import { childIdsOf, isGroup } from '@/features/elements/tree';
import type { CanvasStore } from '@/store/index';
import type { ElementId, ElementStore } from '@/types';

export interface LayerRow {
  readonly id: ElementId;
  /** 0 at root. Rendered as indentation, never as nesting. */
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly parentId: ElementId | null;
  /** Position among the *displayed* siblings, top-first. For `aria-posinset`. */
  readonly indexInParent: number;
  readonly siblingCount: number;
}

/**
 * Flattens the element tree into the rows the panel windows.
 *
 * Children of a collapsed group are omitted entirely rather than hidden, so
 * `rows.length` is the navigable count and `aria-rowcount` stays honest - a
 * collapsed group's members are not reachable by arrow key, and counting them
 * would misreport the list's length to a screen reader.
 *
 * **The visited set is the crash guard, not an optimisation.** `childIds` is
 * data that survives a round trip through a project file, so a group listing
 * itself - or two groups listing each other - is a document that can exist, and
 * a walk without it would recurse until the stack died. Every other walk in
 * `features/elements/tree.ts` carries one for the same reason; a *render* path
 * is the last place that should be the exception.
 */
export function buildLayerRows(
  store: ElementStore,
  collapsed: ReadonlySet<ElementId>
): readonly LayerRow[] {
  const rows: LayerRow[] = [];
  const visited = new Set<ElementId>();

  const walk = (ids: readonly ElementId[], depth: number, parentId: ElementId | null): void => {
    /*
      Top-first: the thing in front is at the top of the list, which is the
      reverse of paint order. Resolved up front rather than during the loop so
      `siblingCount` counts the rows that will actually exist - a childId
      naming a missing element, or one already reached through a cycle, must
      not leave a gap in the `aria-posinset` sequence.
    */
    const siblings: ElementId[] = [];
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const id = ids[i];
      if (id === undefined || visited.has(id)) continue;
      if (store.byId[id] === undefined) continue;
      visited.add(id);
      siblings.push(id);
    }

    siblings.forEach((id, indexInParent) => {
      const childIds = childIdsOf(store, id);
      const hasChildren = childIds.length > 0;
      const expanded = hasChildren && !collapsed.has(id);
      rows.push({
        id,
        depth,
        parentId,
        indexInParent,
        siblingCount: siblings.length,
        hasChildren,
        expanded,
      });
      if (expanded) walk(childIds, depth + 1, id);
    });
  };

  walk(store.order, 0, null);
  return rows;
}

/* ------------------------------------------------------------- subscribing -- */

/**
 * The rows, as a store selector with a stable identity.
 *
 * The panel cannot subscribe to `state.elements`: a drag patches an element on
 * every pointermove, so the panel would re-render every frame of every gesture -
 * the exact mistake `docs/architecture.md` calls a bug rather than a
 * performance nit. But a *tree* of rows needs more than the root order it used
 * to subscribe to; it needs every group's membership too.
 *
 * The way out is that rows depend only on the tree's **shape** - `order` plus
 * each group's `childIds` - and neither array is rebuilt by a patch:
 * `patchDocument` re-spreads `byId` but hands back the same `order`, and
 * `{ ...element, x }` keeps the same `childIds`. So the shape is compared by
 * reference, and the previously built rows are returned unchanged whenever it
 * matches. Zustand's default `Object.is` then sees no new value and the panel
 * does not re-render. Grouping, ungrouping, reordering, adding or deleting all
 * change a reference here and do rebuild.
 *
 * One module-level slot rather than a per-component memo because there is one
 * layers panel; a second subscriber would thrash the slot but never see a wrong
 * answer, since a miss recomputes from the store it was handed.
 */
let cache: {
  readonly shape: readonly (readonly ElementId[])[];
  readonly collapsed: ReadonlySet<ElementId>;
  readonly rows: readonly LayerRow[];
} | null = null;

export function selectLayerRows(state: CanvasStore): readonly LayerRow[] {
  const store = state.elements;
  const collapsed = state.collapsedGroupIds;
  const shape = treeShape(store);

  if (cache !== null && cache.collapsed === collapsed && sameRefs(cache.shape, shape)) {
    return cache.rows;
  }

  const rows = buildLayerRows(store, collapsed);
  cache = { shape, collapsed, rows };
  return rows;
}

/** `order` followed by every group's `childIds`, by reference. */
function treeShape(store: ElementStore): readonly (readonly ElementId[])[] {
  const shape: (readonly ElementId[])[] = [store.order];
  for (const element of Object.values(store.byId)) {
    if (isGroup(element)) shape.push(element.childIds);
  }
  return shape;
}

function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- reorder -- */

/**
 * Where a keyboard move of one place - up (`-1`) or down (`+1`) - lands in
 * `elements.order`, or `null` if it cannot be made here.
 *
 * `moveToIndex` moves an id within the *root* order, and the panel's rows are no
 * longer that list - a nested row's display index says nothing about a position
 * in `order`. So the display index is converted by counting root rows, and a row
 * that is not at the root is refused outright rather than moved somewhere
 * arithmetic happened to point.
 *
 * **The pointer no longer comes through here.** Dragging resolves to a parent
 * and an index in `dropTarget.ts` and commits through `reparent`, which can move
 * a row between levels; Alt+Arrow still speaks only about the root order, so a
 * member stays put under it. Refusing beats guessing: moving a member by
 * pretending its row index is a root index would corrupt the document.
 */
export function rootStepTarget(
  rows: readonly LayerRow[],
  id: ElementId,
  delta: number
): number | null {
  const fromIndex = rows.findIndex((row) => row.id === id);
  if (fromIndex === -1 || rows[fromIndex]?.depth !== 0) return null;

  const rootFrom = rootRowsBefore(rows, fromIndex);
  const rootCount = rootRowsBefore(rows, rows.length);
  const rootTarget = Math.min(Math.max(rootFrom + delta, 0), rootCount - 1);
  if (rootTarget === rootFrom) return null;
  return toDocumentIndex(rootTarget, rootCount);
}

/** Root rows strictly above `limit`, which is also the root index of that gap. */
function rootRowsBefore(rows: readonly LayerRow[], limit: number): number {
  let count = 0;
  const end = Math.min(limit, rows.length);
  for (let i = 0; i < end; i += 1) {
    if (rows[i]?.depth === 0) count += 1;
  }
  return count;
}

/** Display index (top-first) ↔ document index (bottom-to-top). Its own inverse. */
function toDocumentIndex(displayIndex: number, total: number): number {
  return total - 1 - displayIndex;
}
