import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { IconButton } from '@/components/common';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface PanelSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the sheet, and the heading shown in its bar. */
  title: string;
  children: ReactNode;
}

/**
 * The docked panel rail, presented as an overlay for viewports too narrow to
 * hold it.
 *
 * Below `lg` there is not room for a canvas *and* 272px of panels: giving the
 * panels their column would leave the canvas a strip, and the spec's own rule is
 * that no control may become unusable on a small screen. So the panels stop
 * being a column and become a sheet over the canvas - the canvas keeps its full
 * width, and the panels are summoned and dismissed instead of permanently
 * present.
 *
 * That change of *presentation* is the whole component. The panels inside it are
 * the same components the desktop rail mounts, with the same store bindings; a
 * "mobile properties panel" would be a second implementation of the same thing
 * and would drift within a week.
 *
 * **It is modal on purpose.** The sheet floats over the canvas and a press
 * outside it lands on the canvas, so leaving focus free would let Tab walk
 * behind an opaque overlay onto controls the user cannot see. Focus is trapped,
 * Escape dismisses, and focus returns to the toolbar toggle that opened it.
 *
 * No exit animation, unlike `Dialog`: a sheet is dismissed far more often than a
 * dialog and usually in order to get at the canvas underneath it, so it leaves
 * immediately rather than spending 120ms on the way out.
 */
export function PanelSheet({ open, onClose, title, children }: PanelSheetProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  useFocusTrap(sheetRef, open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Late in the bubble path and not capturing: an inline rename inside the
      // layers panel stops propagation on its own node, so Escape cancels the
      // rename first and only closes the sheet once nothing nested wants it.
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={backdropRef}
      // Below the z-index of `Dialog` (z-40): a dialog opened from inside the
      // sheet must cover it, not slide underneath.
      className="bg-overlay animate-fade-in fixed inset-0 z-30"
      onMouseDown={(event) => {
        // The backdrop itself, not a press that began inside the sheet and
        // drifted out while dragging a layer row.
        if (event.target === backdropRef.current) onClose();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // `w-68` is the desktop rail's own width - 16rem of panel plus its
        // padding - so the sheet is literally the rail, floated. `max-w` keeps
        // it from covering the entire canvas on the narrowest screens.
        className="bg-surface-0 border-edge animate-overlay-in absolute inset-y-0 right-0 flex w-68 max-w-[90vw] flex-col border-l shadow-[var(--cf-shadow-popover)]"
      >
        <header className="border-edge flex h-12 shrink-0 items-center justify-between gap-2 border-b pr-1.5 pl-3">
          <h2 className="text-ink-soft text-[0.6875rem] font-semibold tracking-wider uppercase">
            {title}
          </h2>
          <IconButton
            icon={X}
            label={`Close ${title.toLowerCase()}`}
            size="sm"
            shortcut="escape"
            tooltipSide="left"
            onClick={onClose}
          />
        </header>

        {/* The sheet scrolls as one column: two independently scrolling panels
            inside 100dvh of height is a gesture nobody can aim at on a tablet. */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
