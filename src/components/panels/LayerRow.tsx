import { memo, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowRight,
  Circle,
  Eye,
  EyeOff,
  GripVertical,
  Group as GroupIcon,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Minus,
  PenTool,
  Square,
  Type,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { IconButton } from '@/components/common';
import { LAYER_INDENT_PX, LAYER_ROW_INSET_PX } from '@/constants';
import { effectiveLocked, effectiveVisible } from '@/features/elements/tree';
import { DropLine, DropRing, RenameField, Twisty } from './LayerRowControls';
import type { LayerRow as LayerRowData } from './layerRows';
import { useCanvasStore, useElement, useIsSelected } from '@/store/index';
import type { ElementId, ElementType } from '@/types';
import { cn } from '@/utils/cn';

/** The modifier keys a selection gesture cares about - pointer or keyboard. */
export interface SelectModifiers {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export interface LayerRowProps {
  /**
   * Structure, not content. Its identity is stable while the tree's shape is,
   * which is what keeps `memo` effective - see `layerRows.ts`.
   */
  row: LayerRowData;
  /** Position in the displayed, top-first list. */
  index: number;
  /** Holds the list's single tab stop (roving tabindex). */
  focused: boolean;
  renaming: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  /** The drop would make the dragged row a member of *this* group. */
  dropInto: boolean;
  onSelect: (index: number, modifiers: SelectModifiers) => void;
  onFocusRow: (index: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void;
  onRenameStart: (id: ElementId) => void;
  onRenameEnd: () => void;
  /**
   * `index` is the row's own display index at the moment of pointerdown -
   * also `planDrop`'s `fromIndex`. Handing it over here means the hook never
   * has to scan the row list to find where the drag started.
   */
  onGripDown: (event: ReactPointerEvent, id: ElementId, index: number) => void;
  onToggleCollapse: (id: ElementId) => void;
}

const TYPE_ICON: Readonly<Record<ElementType, LucideIcon>> = {
  rectangle: Square,
  ellipse: Circle,
  line: Minus,
  arrow: ArrowRight,
  text: Type,
  image: ImageIcon,
  freehand: PenTool,
  group: GroupIcon,
};

/**
 * One layer.
 *
 * Memoized and reading its own element through `useElement(id)`, which together
 * are what stop a 500-row list from re-rendering because one shape moved: the
 * panel above subscribes to the tree's *shape* (`layerRows.ts`), not to
 * `elements` itself, so a canvas drag that only moves an ungrouped element does
 * not re-render the panel - a grouped drag also patches the group's derived
 * box on every pointermove, and `deriveGroups.ts` keeps that box-only rewrite
 * from disturbing any `childIds` reference, so the shape stays unchanged there
 * too. Either way only the dragged element's own row sees new data, through
 * `useElement`.
 *
 * The list is a `treegrid` (`row`/`gridcell`) rather than a listbox or a plain
 * `tree`, because rows contain interactive controls - a visibility button, a
 * lock button, an inline rename field - and neither `option` nor `treeitem` is
 * allowed to contain those. Treegrid keeps `aria-selected` on the row, which is
 * the fact a screen-reader user needs, adds `aria-level` / `aria-expanded` for
 * the nesting, and still lets the controls inside remain real buttons.
 */
export const LayerRow = memo(function LayerRow({
  row,
  index,
  focused,
  renaming,
  dragging,
  dropBefore,
  dropAfter,
  dropInto,
  onSelect,
  onFocusRow,
  onKeyDown,
  onRenameStart,
  onRenameEnd,
  onGripDown,
  onToggleCollapse,
}: LayerRowProps) {
  const { id, depth, hasChildren, expanded, parentId, indexInParent, siblingCount } = row;
  const element = useElement(id);
  const selected = useIsSelected(id);
  /*
    Inherited state, read here rather than passed down.

    A group's `visible` and `locked` govern everything under it
    (`effectiveVisible` / `effectiveLocked`), and the row has to say so without
    writing to the member's own flag - the member is not hidden, it is *inside*
    something hidden, and flattening that into its own flag would survive the
    group being shown again.

    Both are booleans about the *parent*, so they change only when an ancestor
    is toggled - narrow enough to subscribe per row, and the panel above cannot
    supply them anyway: it deliberately does not re-render when an element is
    patched.
  */
  const hiddenByAncestor = useCanvasStore(
    (state) => parentId !== null && !effectiveVisible(state.elements, parentId)
  );
  const lockedByAncestor = useCanvasStore(
    (state) => parentId !== null && effectiveLocked(state.elements, parentId)
  );
  const rowRef = useRef<HTMLDivElement>(null);

  // Returning focus to the row when the rename field goes away keeps the
  // keyboard user where they were instead of dumping focus on <body>.
  const wasRenaming = useRef(renaming);
  useEffect(() => {
    if (wasRenaming.current && !renaming) rowRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  if (element === undefined) return null;

  const Icon = TYPE_ICON[element.type];
  const shown = element.visible && !hiddenByAncestor;
  const locked = element.locked || lockedByAncestor;

  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selected}
      aria-level={depth + 1}
      aria-posinset={indexInParent + 1}
      aria-setsize={siblingCount}
      // Only groups have a disclosed state; on a leaf the attribute would claim
      // there is something inside to open.
      {...(hasChildren && { 'aria-expanded': expanded })}
      // 1-based, and load-bearing: the list is virtualized, so the DOM holds a
      // window of rows rather than all of them. Without this a screen reader
      // would announce the fourth rendered row as "row 4" no matter where in
      // 2,000 layers the user actually is.
      aria-rowindex={index + 1}
      data-layer-row
      data-layer-index={index}
      tabIndex={focused ? 0 : -1}
      onFocus={() => {
        onFocusRow(index);
      }}
      onKeyDown={(event) => {
        // Keystrokes inside the rename field belong to the field. Letting them
        // bubble means Enter commits the name and then immediately reopens the
        // editor, and Space is swallowed by the row's select shortcut instead
        // of typing a space.
        if (event.target instanceof HTMLInputElement) return;
        onKeyDown(event, index);
      }}
      onPointerDown={(event) => {
        // The buttons and the rename field own their own presses; only the row
        // body is a selection gesture.
        if (event.target instanceof Element && event.target.closest('button, input') !== null) {
          return;
        }
        onSelect(index, event);
      }}
      onDoubleClick={() => {
        onRenameStart(id);
      }}
      // Depth is indentation, not nesting: the list is virtualized on a fixed
      // row height, so a member's row has to be the same box as a root row.
      style={{ paddingLeft: depth * LAYER_INDENT_PX + LAYER_ROW_INSET_PX }}
      className={cn(
        'relative mx-1 flex h-8 items-center gap-1 rounded-[0.3125rem] pr-0.5 select-none',
        'transition-colors duration-120 ease-out',
        selected ? 'bg-accent-subtle text-accent' : 'text-ink-soft hover:bg-surface-2',
        // Hidden layers still have to be readable - dimmed, not erased. Keyed
        // on the effective state, so a member of a hidden group dims too.
        !shown && 'opacity-55',
        dragging && 'opacity-40'
      )}
    >
      {dropBefore && <DropLine edge="top" depth={depth} />}
      {dropInto && <DropRing />}

      <div role="gridcell" className="flex min-w-0 flex-1 items-center gap-1.5">
        <Twisty
          expanded={hasChildren ? expanded : null}
          onToggle={() => {
            onToggleCollapse(id);
          }}
        />

        <span
          aria-hidden="true"
          data-layer-grip
          onPointerDown={(event) => {
            onGripDown(event, id, index);
          }}
          // `touch-none` is required for a pointer drag to receive moves on
          // touch, and it suppresses scrolling wherever it is applied - so it
          // lives on the grip alone, leaving the rest of the row free to scroll
          // the list. Alt+Arrow is the keyboard route to the same operation.
          className="text-ink-muted hover:text-ink shrink-0 cursor-grab touch-none"
        >
          <GripVertical size={13} strokeWidth={1.75} />
        </span>

        <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />

        {renaming ? (
          <RenameField id={id} initial={element.name} onDone={onRenameEnd} />
        ) : (
          <span className="truncate text-[0.8125rem]">{element.name}</span>
        )}
      </div>

      <div role="gridcell" className="flex shrink-0 items-center">
        {/*
          Inherited state disables the control rather than hiding it, and the
          label names the cause. Leaving it live would offer "Show Rectangle 3"
          on something a group above is hiding - a button whose press changes
          nothing on screen, which is the classic way an interface lies. The
          control comes back the moment the group does.
        */}
        <IconButton
          icon={shown ? Eye : EyeOff}
          label={
            hiddenByAncestor
              ? `${element.name} is hidden by its group`
              : element.visible
                ? `Hide ${element.name}`
                : `Show ${element.name}`
          }
          size="sm"
          tooltip={false}
          disabled={hiddenByAncestor}
          onClick={() => {
            useCanvasStore.getState().toggleVisible(id);
          }}
        />
        <IconButton
          icon={locked ? Lock : LockOpen}
          label={
            lockedByAncestor
              ? `${element.name} is locked by its group`
              : element.locked
                ? `Unlock ${element.name}`
                : `Lock ${element.name}`
          }
          size="sm"
          tooltip={false}
          // Locked reads as a pressed toggle - a state, not an action. The
          // control is always rendered rather than revealed on hover: a button
          // that only exists under a pointer is a button a keyboard or touch
          // user has to discover by accident.
          active={locked}
          disabled={lockedByAncestor}
          onClick={() => {
            useCanvasStore.getState().toggleLocked(id);
          }}
        />
      </div>

      {dropAfter && <DropLine edge="bottom" depth={depth} />}
    </div>
  );
});
