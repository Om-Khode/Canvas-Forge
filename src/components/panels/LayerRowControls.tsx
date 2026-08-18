/**
 * The three small pieces of `LayerRow` that are not the row itself: the
 * drop-target rule, the disclosure triangle, and the inline rename field.
 *
 * Extracted so `LayerRow.tsx` stays a component about *one row*, not also
 * about a triangle's focus semantics and a rename field's commit behaviour -
 * each of the three is a self-contained unit with no reason to see the row's
 * own props.
 */

import { useCallback, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { TextField } from '@/components/common';
import { LAYER_INDENT_PX, LAYER_ROW_INSET_PX } from '@/constants';
import { useCanvasStore } from '@/store/index';
import type { ElementId } from '@/types';
import { cn } from '@/utils/cn';

/**
 * A 2px rule in the gap the dragged row would land in.
 *
 * Left-inset by the *hovered* row's own depth, the same arithmetic the row
 * uses for its `paddingLeft`. Without this the line is an absolutely
 * positioned child sized against the row's padding *box*, which an
 * absolutely positioned element's offsets ignore - so two drops that land at
 * different parents (a member's gap versus the root gap one row below it)
 * rendered as the same full-width rule at the same y, and the one fact this
 * whole feature exists to show - which level the drop lands at - was
 * invisible.
 */
export function DropLine({ edge, depth }: { edge: 'top' | 'bottom'; depth: number }) {
  return (
    <span
      aria-hidden="true"
      data-drop-indicator
      style={{ left: depth * LAYER_INDENT_PX + LAYER_ROW_INSET_PX }}
      className={cn(
        'bg-accent pointer-events-none absolute right-1 h-0.5 rounded-full',
        edge === 'top' ? '-top-px' : '-bottom-px'
      )}
    />
  );
}

/**
 * A drop *into* this group, drawn as a ring around the whole row.
 *
 * A line says "between"; nothing about a line can say "inside", and the two
 * drops are a quarter of a row apart. Outlining the container the row would
 * join is the distinction the pointer is actually making, and it is the same
 * gesture vocabulary a file manager uses.
 */
export function DropRing() {
  return (
    <span
      aria-hidden="true"
      data-drop-indicator
      className="ring-accent pointer-events-none absolute inset-0 rounded-[0.3125rem] ring-2 ring-inset"
    />
  );
}

/**
 * The disclosure triangle, or the gap where one would be.
 *
 * A `<span>`, not a `<button>`. It was a button with `tabIndex={-1}` and
 * `aria-hidden`, and that combination is an axe `aria-hidden-focus`
 * violation: Chrome and Firefox still focus a `<button>` on mousedown
 * regardless of `tabIndex`, so clicking the triangle parked focus inside an
 * `aria-hidden` subtree. A `<span>` cannot receive focus at all, so the same
 * click/pointer handling is safe to hide from assistive tech without the risk.
 *
 * Hiding it is still the right call: the row already carries `aria-expanded`,
 * so this would be a second announcement of the same fact, and the WAI-ARIA
 * treegrid pattern puts expand/collapse on the row itself - ArrowRight and
 * ArrowLeft. This is the pointer's way in, nothing more.
 *
 * The leaf case renders a spacer rather than nothing, so type icons line up
 * down a level instead of jittering left where a sibling has no children.
 */
export function Twisty({
  expanded,
  onToggle,
}: {
  expanded: boolean | null;
  onToggle: () => void;
}) {
  if (expanded === null) return <span aria-hidden="true" className="size-3.5 shrink-0" />;

  return (
    <span
      aria-hidden="true"
      data-layer-twisty
      className="text-ink-muted hover:text-ink flex size-3.5 shrink-0 cursor-pointer items-center justify-center"
      onClick={onToggle}
      // The row turns a double-click into a rename; on the triangle that would
      // fold the group twice and then open an editor nobody asked for.
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
    >
      <ChevronRight
        size={12}
        strokeWidth={2}
        className={cn('transition-transform duration-120 ease-out', expanded && 'rotate-90')}
      />
    </span>
  );
}

export function RenameField({
  id,
  initial,
  onDone,
}: {
  id: ElementId;
  initial: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initial);

  // A callback ref rather than `autoFocus`: the field appears in response to a
  // click or Enter, and the text should be selected so typing replaces it.
  const focusOnMount = useCallback((node: HTMLInputElement | null): void => {
    node?.focus();
    node?.select();
  }, []);

  return (
    <TextField
      ref={focusOnMount}
      label="Layer name"
      hideLabel
      fieldSize="sm"
      value={value}
      className="min-w-0 flex-1"
      onChange={setValue}
      onCommit={(next) => {
        const trimmed = next.trim();
        // An empty name would leave an unlabelled row; reverting is kinder than
        // rejecting with an error the user has to dismiss.
        if (trimmed.length > 0 && trimmed !== initial) {
          useCanvasStore.getState().setElementName(id, trimmed);
        }
        onDone();
      }}
      onCancel={onDone}
    />
  );
}
