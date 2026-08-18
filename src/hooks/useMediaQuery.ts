import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query from React.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect` because the
 * effect version reads the query *after* the first paint: the component renders
 * once with a wrong answer, then corrects. For layout decisions ("is this a
 * touch-sized viewport, do the panels start collapsed") that first wrong render
 * is a visible flash of the wrong UI.
 */
export function useMediaQuery(query: string): boolean {
  const mediaQueryList = useMemo(() => window.matchMedia(query), [query]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      mediaQueryList.addEventListener('change', onChange);
      return () => {
        mediaQueryList.removeEventListener('change', onChange);
      };
    },
    [mediaQueryList]
  );

  const getSnapshot = useCallback(() => mediaQueryList.matches, [mediaQueryList]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Named breakpoints, matching Tailwind's defaults so a JS branch and a CSS
 * breakpoint can never drift apart by a pixel.
 */
export const BREAKPOINT_QUERIES = {
  sm: '(min-width: 40rem)',
  md: '(min-width: 48rem)',
  lg: '(min-width: 64rem)',
  xl: '(min-width: 80rem)',
} as const;

export type Breakpoint = keyof typeof BREAKPOINT_QUERIES;

/** True when the viewport is at least the given breakpoint wide. */
export function useBreakpoint(breakpoint: Breakpoint): boolean {
  return useMediaQuery(BREAKPOINT_QUERIES[breakpoint]);
}

/**
 * Read once, at the top of any animation you're about to run imperatively.
 * The CSS guard in index.css covers declarative animation; this covers the
 * handful of places that animate in JS.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
