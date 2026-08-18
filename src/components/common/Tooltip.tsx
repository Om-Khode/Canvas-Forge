import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from './Kbd';
import { cn } from '@/utils/cn';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/** Long enough that tooltips don't chase the cursor across a toolbar. */
const OPEN_DELAY_MS = 400;
/**
 * After any tooltip closes, the next one opens instantly for this long. Without
 * it, sweeping across a twelve-button toolbar means twelve separate 400ms
 * waits; with it, the toolbar behaves like one surface once you're "in" it.
 * Module-level, because the whole point is that it is shared between triggers.
 */
const SKIP_DELAY_MS = 300;
const GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;

let lastClosedAt = 0;

/**
 * Focus should open a tooltip for a keyboard user and stay quiet for a mouse
 * user - clicking a toolbar button focuses it, and a tooltip popping up over
 * the thing you just clicked is noise.
 *
 * `:focus-visible` expresses exactly this, but only as a CSS selector whose
 * support in `Element.matches` is uneven. Tracking the modality directly is
 * three lines, behaves identically, and is deterministic under test.
 */
let lastInteractionWasKeyboard = false;
document.addEventListener(
  'keydown',
  () => {
    lastInteractionWasKeyboard = true;
  },
  true
);
document.addEventListener(
  'pointerdown',
  () => {
    lastInteractionWasKeyboard = false;
  },
  true
);

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

interface Placement {
  top: number;
  left: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Fixed-position anchoring: flip to the opposite side when the preferred one
 * would leave the viewport, then clamp along the cross axis.
 *
 * A positioning library buys shift/arrow/virtual-element support this project
 * has no use for. Two rules and ~30 lines cover every tooltip and popover in
 * the editor, and they're rules we can explain.
 */
function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  open: boolean,
  preferredSide: TooltipSide
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    // Placement is deliberately *not* cleared on close. The floating element
    // unmounts anyway, and on the next open this effect runs before paint, so
    // a stale value is overwritten with the correct one in the same frame.
    if (!open) return;

    const compute = (): void => {
      // The wrapper is `display: contents` so it adds nothing to layout, which
      // also means it has no box to measure - take the trigger it wraps.
      const host = anchorRef.current;
      const anchor: Element | null = host?.firstElementChild ?? host;
      const floating = floatingRef.current;
      if (anchor === null || floating === null) return;

      const a = anchor.getBoundingClientRect();
      const f = floating.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const coordsFor = (side: TooltipSide): Placement => {
        switch (side) {
          case 'top':
            return { top: a.top - f.height - GAP_PX, left: a.left + a.width / 2 - f.width / 2 };
          case 'bottom':
            return { top: a.bottom + GAP_PX, left: a.left + a.width / 2 - f.width / 2 };
          case 'left':
            return { top: a.top + a.height / 2 - f.height / 2, left: a.left - f.width - GAP_PX };
          case 'right':
            return { top: a.top + a.height / 2 - f.height / 2, left: a.right + GAP_PX };
        }
      };

      let side = preferredSide;
      let coords = coordsFor(side);
      const fits =
        side === 'top'
          ? coords.top >= VIEWPORT_MARGIN_PX
          : side === 'bottom'
            ? coords.top + f.height <= vh - VIEWPORT_MARGIN_PX
            : side === 'left'
              ? coords.left >= VIEWPORT_MARGIN_PX
              : coords.left + f.width <= vw - VIEWPORT_MARGIN_PX;

      if (!fits) {
        side = OPPOSITE[side];
        coords = coordsFor(side);
      }

      setPlacement({
        top: clamp(coords.top, VIEWPORT_MARGIN_PX, vh - f.height - VIEWPORT_MARGIN_PX),
        left: clamp(coords.left, VIEWPORT_MARGIN_PX, vw - f.width - VIEWPORT_MARGIN_PX),
      });
    };

    compute();
    // Capture phase catches scrolling inside a panel, not just the window.
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, preferredSide, anchorRef, floatingRef]);

  return placement;
}

export interface TooltipProps {
  label: ReactNode;
  /** Platform-neutral chord, rendered as keycaps beside the label. */
  shortcut?: string;
  side?: TooltipSide;
  delay?: number;
  disabled?: boolean;
  /**
   * Wires `aria-describedby` onto the trigger. Turn it off when the tooltip
   * merely repeats the trigger's accessible name (icon buttons) - otherwise a
   * screen reader announces the same words twice.
   */
  linkDescription?: boolean;
  children: ReactElement<{ 'aria-describedby'?: string | undefined }>;
}

/**
 * Hover/focus tooltip. Never receives focus and never traps it: it is a portal
 * with `pointer-events: none`, so it cannot be hovered, clicked, or tabbed to.
 * Anything a user must interact with belongs in a popover, not here.
 */
export function Tooltip({
  label,
  shortcut,
  side = 'top',
  delay = OPEN_DELAY_MS,
  disabled = false,
  linkDescription = true,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const id = useId();

  const placement = useAnchoredPosition(anchorRef, floatingRef, open, side);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelTimer();
    setOpen((wasOpen) => {
      if (wasOpen) lastClosedAt = Date.now();
      return false;
    });
  }, [cancelTimer]);

  const scheduleOpen = useCallback(
    (immediate: boolean) => {
      if (disabled) return;
      cancelTimer();
      if (immediate || Date.now() - lastClosedAt < SKIP_DELAY_MS) {
        setOpen(true);
        return;
      }
      timerRef.current = window.setTimeout(() => {
        setOpen(true);
      }, delay);
    },
    [cancelTimer, delay, disabled]
  );

  useEffect(() => cancelTimer, [cancelTimer]);

  // Escape dismisses the tooltip without touching whatever else is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const trigger = linkDescription
    ? cloneElement(children, { 'aria-describedby': open ? id : undefined })
    : children;

  return (
    <>
      <span
        ref={anchorRef}
        className="contents"
        onPointerEnter={(event) => {
          // Touch has no hover; a tap should activate the control, not reveal a
          // tooltip the user then has to dismiss.
          if (event.pointerType !== 'touch') scheduleOpen(false);
        }}
        onPointerLeave={close}
        onPointerDown={close}
        onFocusCapture={() => {
          if (lastInteractionWasKeyboard) scheduleOpen(true);
        }}
        onBlurCapture={close}
      >
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={floatingRef}
            id={id}
            role="tooltip"
            style={{
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              visibility: placement === null ? 'hidden' : 'visible',
            }}
            className={cn(
              'pointer-events-none fixed z-50 flex items-center gap-2',
              'bg-tooltip text-tooltip-fg rounded-field px-2 py-1',
              'shadow-popover text-xs font-medium whitespace-nowrap',
              'animate-pop-in'
            )}
          >
            <span>{label}</span>
            {shortcut !== undefined && <Kbd keys={shortcut} tone="inverted" />}
          </div>,
          document.body
        )}
    </>
  );
}
