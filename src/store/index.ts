/**
 * The store: one Zustand store composed from six slice creators.
 *
 * Zustand over Redux for the boilerplate-to-value ratio at this size, and over
 * Context because Context re-renders *every* consumer on any change - fatal for
 * a store written to on every pointermove of a drag
 * (docs/decisions/002-state-management.md).
 *
 * The slices share one flat state object rather than nesting under keys, which
 * is what lets `elementsSlice` call `get().applyDocument(...)` and keeps the
 * single write path into history honest. The price is that slice names must not
 * collide; they are reviewed as one surface for that reason.
 *
 * **Subscribe narrowly.** Every hook exported below selects one value. A panel
 * that subscribes to the whole elements map re-renders on every frame of a
 * drag, and that is treated as a bug, not a performance nit. For selectors that
 * build a fresh array or object each call, use `useCanvasStoreShallow`.
 */

import { createElementsSlice } from '@/store/elementsSlice';
import type { ElementsSlice } from '@/store/elementsSlice';
import {
  createHistorySlice,
  selectCanRedo,
  selectCanUndo,
  selectRedoLabel,
  selectUndoLabel,
} from '@/store/historySlice';
import type { HistorySlice } from '@/store/historySlice';
import { createSelectionSlice } from '@/store/selectionSlice';
import type { SelectionSlice } from '@/store/selectionSlice';
import { createToolSlice, selectActiveStyle } from '@/store/toolSlice';
import type { StyleableToolId, ToolSlice } from '@/store/toolSlice';
import { createUiSlice } from '@/store/uiSlice';
import type { DialogId, PanelId, UiSlice } from '@/store/uiSlice';
import { createViewportSlice } from '@/store/viewportSlice';
import type { ViewportSlice } from '@/store/viewportSlice';
import type { ElementStyle } from '@/features/elements/factory';
import type {
  CanvasElement,
  ElementId,
  ElementStore,
  InteractionState,
  SaveStatus,
  ToolId,
  Viewport,
} from '@/types';
import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

export type CanvasStore = ElementsSlice &
  SelectionSlice &
  ViewportSlice &
  ToolSlice &
  UiSlice &
  HistorySlice;

export const createCanvasState: StateCreator<CanvasStore> = (...args) => ({
  ...createElementsSlice(...args),
  ...createSelectionSlice(...args),
  ...createViewportSlice(...args),
  ...createToolSlice(...args),
  ...createUiSlice(...args),
  ...createHistorySlice(...args),
});

/**
 * Also the imperative handle: the renderer uses `useCanvasStore.subscribe` and
 * `getState` to redraw without involving React, and services read `getState`
 * outside of any component.
 */
export const useCanvasStore = create<CanvasStore>()(createCanvasState);

/** Restores the pristine state. Test-only in practice, but not test-only code. */
export function resetCanvasStore(): void {
  useCanvasStore.setState(useCanvasStore.getInitialState(), true);
}

/**
 * For selectors that construct a new array/object/Set each call. Without a
 * shallow comparison those re-render on every store write regardless of whether
 * the contents changed, which is the single easiest way to undo all of the
 * above.
 */
export function useCanvasStoreShallow<U>(selector: (state: CanvasStore) => U): U {
  return useCanvasStore(useShallow(selector));
}

/* ---------------------------------------------------------------- document -- */

export function useElementStore(): ElementStore {
  return useCanvasStore((state) => state.elements);
}

export function useElement(id: ElementId): CanvasElement | undefined {
  return useCanvasStore((state) => state.elements.byId[id]);
}

/* --------------------------------------------------------------- selection -- */

export function useSelection(): ReadonlySet<ElementId> {
  return useCanvasStore((state) => state.selection);
}

export function useSelectionCount(): number {
  return useCanvasStore((state) => state.selection.size);
}

export function useIsSelected(id: ElementId): boolean {
  return useCanvasStore((state) => state.selection.has(id));
}

export function useSelectedIds(): readonly ElementId[] {
  return useCanvasStoreShallow((state) => [...state.selection]);
}

/* ---------------------------------------------------------------- viewport -- */

export function useViewport(): Viewport {
  return useCanvasStore((state) => state.viewport);
}

export function useZoom(): number {
  return useCanvasStore((state) => state.viewport.zoom);
}

/* -------------------------------------------------------------------- tool -- */

export function useActiveTool(): ToolId {
  return useCanvasStore((state) => state.tool);
}

export function useInteraction(): InteractionState {
  return useCanvasStore((state) => state.interaction);
}

export function useActiveStyle(): ElementStyle {
  return useCanvasStore(selectActiveStyle);
}

export function useDefaultStyle(tool: StyleableToolId): ElementStyle {
  return useCanvasStore((state) => state.defaultStyles[tool]);
}

/* ---------------------------------------------------------------------- ui -- */

export function usePanelVisible(panel: PanelId): boolean {
  return useCanvasStore((state) => state.panels[panel]);
}

export function useActiveDialog(): DialogId | null {
  return useCanvasStore((state) => state.activeDialog);
}

export function useSaveStatus(): SaveStatus {
  return useCanvasStore((state) => state.saveStatus);
}

export function useProjectName(): string {
  return useCanvasStore((state) => state.projectName);
}

/* ----------------------------------------------------------------- history -- */

export interface HistoryStatus {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** `null` when the corresponding stack is empty. Used for "Undo Move 3 elements". */
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

export function useHistoryStatus(): HistoryStatus {
  return useCanvasStoreShallow((state) => ({
    canUndo: selectCanUndo(state),
    canRedo: selectCanRedo(state),
    undoLabel: selectUndoLabel(state),
    redoLabel: selectRedoLabel(state),
  }));
}

/* ----------------------------------------------------------------- re-export */

export type { ElementsSlice } from '@/store/elementsSlice';
export { elementsByIds, elementsInOrder, selectSelectedElements } from '@/store/elementsSlice';
export type { SelectionSlice } from '@/store/selectionSlice';
export type { ViewportSizePx, ViewportSlice } from '@/store/viewportSlice';
export { selectZoomPercent } from '@/store/viewportSlice';
export type { StyleableToolId, ToolSlice } from '@/store/toolSlice';
export { isStyleableTool, selectActiveStyle } from '@/store/toolSlice';
export type { DialogId, PanelId, UiSlice } from '@/store/uiSlice';
export { selectEnteredGroupId } from '@/store/uiSlice';
export type { DocumentHistory, HistorySlice } from '@/store/historySlice';
export {
  selectCanRedo,
  selectCanUndo,
  selectIsTransactionOpen,
  selectRedoLabel,
  selectUndoLabel,
} from '@/store/historySlice';
