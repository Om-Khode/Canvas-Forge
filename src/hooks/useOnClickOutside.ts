import { useEffect, useRef, type RefObject } from 'react';

type MaybeRef = RefObject<HTMLElement | null>;

/**
 * Call `handler` when a pointer goes down anywhere outside every given ref.
 *
 * Two decisions worth defending:
 *
 * 1. **`pointerdown`, not `click`.** A popover that closes on click stays open
 *    for the whole press, so a press-drag-release that starts outside it feels
 *    like the popover is sticky. Pointerdown also fires before focus moves,
 *    which is what lets a colour popover close cleanly when the user presses
 *    into the next field.
 *
 * 2. **Capture phase.** A trigger that stops propagation - a canvas swallowing
 *    pointer events, for instance - would otherwise silently break dismissal.
 *
 * The handler is kept in a ref so callers can pass an inline arrow function
 * without re-binding the listener on every render.
 */
export function useOnClickOutside(
  refs: MaybeRef | readonly MaybeRef[],
  handler: (event: PointerEvent) => void,
  enabled = true
): void {
  // Both are latest-value mirrors, not render inputs. Callers pass an inline
  // handler and a fresh array literal on most renders; depending on either
  // directly would tear down and rebind the document listener every render.
  // Written in an effect rather than during render, which is the rule: refs are
  // for values React doesn't render.
  const handlerRef = useRef(handler);
  const refsRef = useRef(refs);

  useEffect(() => {
    handlerRef.current = handler;
    refsRef.current = refs;
  });

  useEffect(() => {
    if (!enabled) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const list = refsRef.current;
      const all = Array.isArray(list) ? (list as readonly MaybeRef[]) : [list as MaybeRef];

      // `isConnected` matters: an element removed mid-interaction still holds a
      // ref, and `contains` on a detached node would report a false "inside".
      const inside = all.some((ref) => {
        const node = ref.current;
        return node !== null && node.isConnected && node.contains(target);
      });

      if (!inside) handlerRef.current(event);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [enabled]);
}
