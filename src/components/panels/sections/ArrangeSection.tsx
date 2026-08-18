import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowUp,
  BringToFront,
  SendToBack,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { IconButton, PanelSection } from '@/components/common';
import { alignElements, distributeElements } from '@/features/alignment/align';
import type { AlignEdge, DistributeAxis, MoveTargets } from '@/features/alignment/align';
import { transformSet } from '@/features/selection/resolve';
import { useCanvasStore } from '@/store/index';
import type { CanvasElement } from '@/types';

export interface ArrangeSectionProps {
  /** The selection, in document order. */
  elements: readonly CanvasElement[];
}

const ALIGNMENTS: readonly { edge: AlignEdge; label: string; icon: LucideIcon }[] = [
  { edge: 'left', label: 'Align left', icon: AlignStartVertical },
  { edge: 'center-x', label: 'Align horizontal centres', icon: AlignCenterVertical },
  { edge: 'right', label: 'Align right', icon: AlignEndVertical },
  { edge: 'top', label: 'Align top', icon: AlignStartHorizontal },
  { edge: 'center-y', label: 'Align vertical centres', icon: AlignCenterHorizontal },
  { edge: 'bottom', label: 'Align bottom', icon: AlignEndHorizontal },
];

const DISTRIBUTIONS: readonly { axis: DistributeAxis; label: string; icon: LucideIcon }[] = [
  { axis: 'horizontal', label: 'Distribute horizontally', icon: AlignHorizontalDistributeCenter },
  { axis: 'vertical', label: 'Distribute vertically', icon: AlignVerticalDistributeCenter },
];

/**
 * Align, distribute, and layer order.
 *
 * Every action here is a single store call, and every one of those store calls
 * routes through `applyDocument` exactly once - so "align 5 elements", which
 * moves five elements, is one undo entry without any explicit transaction
 * bracketing. That is the payoff of `alignElements` being a pure
 * `(elements) => patches` function rather than something that mutates as it
 * goes.
 *
 * Store actions are read through `getState()` at call time rather than
 * subscribed to. They are created once and never replaced, so subscribing to
 * six of them would add six selector runs per store write to learn nothing.
 */
/**
 * Read at click time, not at render time: the alignment maths measures the item
 * (a group's derived box is the extent being aligned) and applies the delta to
 * the leaves that hold real geometry, because a patch naming a group is erased
 * by the store's re-derivation.
 */
function leafExpander(): MoveTargets {
  const document = useCanvasStore.getState().elements;
  return (element) => transformSet(document, [element.id]);
}

export function ArrangeSection({ elements }: ArrangeSectionProps) {
  const ids = elements.map((element) => element.id);
  const canAlign = elements.length >= 2;
  // Distributing needs a gap to even out, and two elements have exactly one.
  const canDistribute = elements.length >= 3;

  return (
    <PanelSection title="Arrange">
      <div role="group" aria-label="Align" className="flex flex-wrap items-center gap-0.5">
        {ALIGNMENTS.map(({ edge, label, icon }) => (
          <IconButton
            key={edge}
            icon={icon}
            label={label}
            size="sm"
            disabled={!canAlign}
            onClick={() => {
              useCanvasStore
                .getState()
                .applyPatches(alignElements(elements, edge, leafExpander()), label);
            }}
          />
        ))}
        <span aria-hidden="true" className="bg-edge mx-1 h-5 w-px" />
        {DISTRIBUTIONS.map(({ axis, label, icon }) => (
          <IconButton
            key={axis}
            icon={icon}
            label={label}
            size="sm"
            disabled={!canDistribute}
            onClick={() => {
              useCanvasStore
                .getState()
                .applyPatches(distributeElements(elements, axis, leafExpander()), label);
            }}
          />
        ))}
      </div>

      <div role="group" aria-label="Layer order" className="flex items-center gap-0.5">
        <IconButton
          icon={BringToFront}
          label="Bring to front"
          size="sm"
          onClick={() => {
            useCanvasStore.getState().bringToFront(ids);
          }}
        />
        <IconButton
          icon={ArrowUp}
          label="Bring forward"
          size="sm"
          onClick={() => {
            useCanvasStore.getState().bringForward(ids);
          }}
        />
        <IconButton
          icon={ArrowDown}
          label="Send backward"
          size="sm"
          onClick={() => {
            useCanvasStore.getState().sendBackward(ids);
          }}
        />
        <IconButton
          icon={SendToBack}
          label="Send to back"
          size="sm"
          onClick={() => {
            useCanvasStore.getState().sendToBack(ids);
          }}
        />
      </div>
    </PanelSection>
  );
}
