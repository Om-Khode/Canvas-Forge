import { useEffect, type RefObject } from 'react';

/**
 * Elements the browser will focus with Tab. `[tabindex]:not([tabindex="-1"])`
 * covers deliberately-focusable non-form elements (a scrollable region, a
 * roving-tabindex group's active item) without picking up programmatic-only
 * focus targets.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true' && !element.hasAttribute('inert')
  );
}

export interface FocusTrapOptions {
  /** Focused on open instead of the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Set false when the caller restores focus itself. */
  restoreFocus?: boolean;
}

/**
 * Confine Tab to `containerRef` while `active`, and put focus back where it
 * came from on close.
 *
 * Why hand-rolled rather than a library: the whole behaviour is the three rules
 * below, and owning them means the dialog's focus story is something the
 * codebase can explain rather than delegate.
 *
 *   1. On open, focus moves into the container - otherwise the keyboard user is
 *      still on the trigger behind a scrim and Tab walks the page underneath.
 *   2. Tab past the last focusable wraps to the first, and Shift+Tab wraps the
 *      other way.
 *   3. On close, focus returns to the element that had it, so the user's place
 *      in the page survives the round trip.
 *
 * Visibility is not filtered (jsdom aside, `offsetParent`/`getClientRects` are
 * layout reads, and running one per focusable on every Tab is a needless
 * reflow). A dialog that renders hidden focusables has a different bug.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options: FocusTrapOptions = {}
): void {
  const { initialFocusRef, restoreFocus = true } = options;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;

    const previouslyFocused = document.activeElement;

    const initial = initialFocusRef?.current ?? focusableWithin(container)[0] ?? container;
    // A container with no focusable children still needs to receive focus, so
    // it carries tabIndex={-1} and becomes the target of last resort.
    initial.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;

      const focusables = focusableWithin(container);
      if (focusables.length === 0) {
        // Nothing to move to - keep focus pinned rather than letting it escape.
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;

      const activeElement = document.activeElement;

      // Focus outside the container (a click on the scrim, a stray
      // programmatic focus) - reel it back to the appropriate edge.
      if (!(activeElement instanceof HTMLElement) || !container.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    // Capture phase so a child that stops propagation cannot break the trap.
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (!restoreFocus) return;
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [active, containerRef, initialFocusRef, restoreFocus]);
}
