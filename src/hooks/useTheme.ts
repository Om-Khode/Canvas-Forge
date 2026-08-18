import { useCallback, useSyncExternalStore } from 'react';
import { LS_THEME } from '@/constants';

export type Theme = 'light' | 'dark';

/**
 * Theme lives here rather than in the Zustand store on purpose.
 *
 * The store is the *document* plus the view state that belongs to a document.
 * Theme is neither: it's a property of the browser, it must be readable before
 * React mounts (index.html applies it inline to avoid a flash), and it has to
 * survive across projects. Putting it in the store would mean the store is
 * initialised twice - once by the inline script, once by hydration - and the
 * two can disagree.
 *
 * So: a ~40 line external store, subscribed to with useSyncExternalStore. Every
 * `useTheme()` caller sees the same value and re-renders together, without a
 * provider and without a store slice.
 */

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** localStorage throws in Safari private mode and when storage is disabled. */
function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(LS_THEME);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: Theme | null): void {
  try {
    if (theme === null) localStorage.removeItem(LS_THEME);
    else localStorage.setItem(LS_THEME, theme);
  } catch {
    /* A theme that doesn't persist is a far smaller failure than a crash. */
  }
}

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * The single source of truth is the DOM attribute the inline script already
 * set. Re-deriving it here would risk computing a different answer from the
 * one the user is currently looking at.
 */
function readAppliedTheme(): Theme {
  const applied = document.documentElement.dataset['theme'];
  return isTheme(applied) ? applied : systemTheme();
}

let current: Theme = readAppliedTheme();
let explicit: boolean = readStoredTheme() !== null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(theme: Theme): void {
  if (current === theme && document.documentElement.dataset['theme'] === theme) return;
  current = theme;
  document.documentElement.dataset['theme'] = theme;
  emit();
}

/**
 * Follow the OS until the user makes a choice, then stop. Attached once at
 * module scope rather than per-hook-instance: N components mounting must not
 * mean N media-query listeners racing to set the same attribute.
 */
window.matchMedia(DARK_QUERY).addEventListener('change', (event) => {
  if (explicit) return;
  apply(event.matches ? 'dark' : 'light');
});

/**
 * Exported so non-React consumers can react to a theme flip. The canvas
 * renderer is the one that matters: it caches the palette it reads out of CSS
 * custom properties, and without a notification it keeps painting the old
 * background and grid until a reload.
 */
export function subscribeTheme(listener: () => void): () => void {
  return subscribe(listener);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Theme {
  return current;
}

function getExplicitSnapshot(): boolean {
  return explicit;
}

/** Explicit user choice: persisted, and the OS is no longer consulted. */
export function setTheme(theme: Theme): void {
  explicit = true;
  writeStoredTheme(theme);
  apply(theme);
  emit();
}

/** Drop the stored preference and resume following the OS. */
export function clearThemePreference(): void {
  explicit = false;
  writeStoredTheme(null);
  apply(systemTheme());
  emit();
}

export interface UseThemeResult {
  theme: Theme;
  /** True once the user has chosen; false while still tracking the OS. */
  isExplicit: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  clearThemePreference: () => void;
}

export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isExplicit = useSyncExternalStore(subscribe, getExplicitSnapshot, getExplicitSnapshot);

  const toggleTheme = useCallback(() => {
    setTheme(getSnapshot() === 'dark' ? 'light' : 'dark');
  }, []);

  return { theme, isExplicit, setTheme, toggleTheme, clearThemePreference };
}
