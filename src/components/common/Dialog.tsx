import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { cn } from '@/utils/cn';

export type DialogSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

/** Must outlast the exit animation in index.css (120ms) with room to spare. */
const EXIT_DURATION_MS = 180;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Rendered under the title and wired up as `aria-describedby`. */
  description?: string;
  size?: DialogSize;
  footer?: ReactNode;
  children: ReactNode;
  /** Focused on open instead of the first focusable child - e.g. a name input. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Off for destructive confirmations, where a stray click must not dismiss. */
  closeOnBackdropClick?: boolean;
  showCloseButton?: boolean;
}

/**
 * Modal dialog: portal, scrim, focus trap, Escape, scroll lock, focus restored
 * to the trigger.
 *
 * Not the native `<dialog>` element. `showModal()` gives Escape and the top
 * layer for free, but its focus behaviour, its `::backdrop` styling, and its
 * interaction with React portals all differ enough across engines that "free"
 * turns into three workarounds. A div with an explicit trap is more code and
 * less surprise, and the trap is reusable - the command palette needs it too.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  initialFocusRef,
  closeOnBackdropClick = true,
  showCloseButton = true,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  /**
   * `open` is the caller's intent; `present` is what's in the DOM. They differ
   * only while the exit animation plays - a component that unmounts the instant
   * `open` flips has no exit animation at all, however it's styled.
   */
  const [present, setPresent] = useState(open);
  const [previousOpen, setPreviousOpen] = useState(open);

  // Mounting is synchronous with the prop change, using React's sanctioned
  // "adjust state during render" pattern. Doing it in an effect would render
  // one frame with the dialog absent, and the enter animation would start a
  // frame late - visible as a stutter on the very first open.
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) setPresent(true);
  }

  const closing = present && !open;

  useEffect(() => {
    if (!closing) return;
    // A timer rather than `animationend`: reduced-motion collapses the
    // animation so short that the event can be missed, and an element that
    // never unmounts is a far worse failure than one that unmounts unanimated.
    const timer = window.setTimeout(() => {
      setPresent(false);
    }, EXIT_DURATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [closing]);

  useFocusTrap(panelRef, present && open, {
    ...(initialFocusRef !== undefined && { initialFocusRef }),
  });

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  /**
   * Escape is listened for on `document`, deliberately late in the bubble path.
   * Anything nested that also wants Escape - a colour popover, an inline text
   * edit - stops propagation on its own node, so it consumes the key before it
   * ever reaches here. One Escape closes one layer, innermost first, with no
   * central registry of who is open.
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      handleClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, handleClose]);

  // Scroll lock. Padding compensates for the scrollbar's width so the page
  // behind the scrim doesn't jump sideways as it disappears.
  useEffect(() => {
    if (!present) return;
    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, [present]);

  if (!present) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className={cn(
        'bg-overlay fixed inset-0 z-40 flex items-end justify-center p-0 sm:items-center sm:p-6',
        closing ? 'animate-fade-out' : 'animate-fade-in'
      )}
      onMouseDown={(event) => {
        // mousedown on the backdrop *itself*, not a press that started inside
        // the panel and drifted out while selecting text.
        if (closeOnBackdropClick && event.target === backdropRef.current) handleClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className={cn(
          'bg-surface-1 border-edge shadow-popover flex w-full flex-col overflow-hidden border',
          'rounded-t-panel sm:rounded-panel max-h-[min(85dvh,44rem)]',
          SIZE_CLASSES[size],
          closing ? 'animate-overlay-out' : 'animate-overlay-in'
        )}
      >
        <header className="border-edge flex items-start gap-4 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-ink text-[0.9375rem] leading-tight font-semibold">
              {title}
            </h2>
            {description !== undefined && (
              <p id={descriptionId} className="text-ink-soft mt-1 text-[0.8125rem] leading-snug">
                {description}
              </p>
            )}
          </div>
          {showCloseButton && (
            <IconButton
              icon={X}
              label="Close"
              size="sm"
              shortcut="escape"
              tooltipSide="left"
              onClick={handleClose}
              className="-mt-0.5 -mr-1.5"
            />
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer !== undefined && (
          <footer className="border-edge bg-surface-2 flex items-center justify-end gap-2 border-t px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}
