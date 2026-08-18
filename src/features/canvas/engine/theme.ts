/**
 * Canvas paint colours, read from the same CSS custom properties the DOM chrome
 * uses.
 *
 * The alternative - a second colour table in TypeScript - means the canvas and
 * the panels around it drift apart the first time a token is retuned, and it
 * makes dark mode two changes instead of one. Reading `--cf-*` off
 * `document.documentElement` keeps `src/index.css` the single palette.
 *
 * The read is cached because `getComputedStyle` forces style resolution, and
 * this runs at the top of every frame. The cache is invalidated explicitly by
 * `refreshTheme()` rather than by watching the DOM: the theme changes exactly
 * when something flips `data-theme`, that code knows it did so, and a
 * MutationObserver here would be machinery to re-derive a fact the caller
 * already has.
 */

export interface CanvasTheme {
  /** Page behind the artboard. */
  readonly background: string;
  /** Dot-grid colour. */
  readonly dot: string;
  /** Selection outlines, handles, marquee. */
  readonly accent: string;
  /** Neutral chrome - per-element outlines in a multi-selection, placeholders. */
  readonly borderStrong: string;
}

const TOKENS = {
  background: '--cf-canvas-bg',
  dot: '--cf-canvas-dot',
  accent: '--cf-accent',
  borderStrong: '--cf-border-strong',
} as const satisfies Record<keyof CanvasTheme, string>;

/**
 * Literal approximations of the light-theme tokens in `src/index.css`.
 *
 * Needed because two real contexts return empty computed styles: jsdom, which
 * does not resolve custom properties, and any offscreen/worker canvas, which
 * has no document at all. Without fallbacks `fillStyle = ''` silently leaves
 * the previous colour in place and export output comes out wrong in a way
 * that's hard to trace. Hex rather than `oklch()` so they parse everywhere.
 */
const FALLBACK: CanvasTheme = {
  background: '#f7f6f4',
  dot: '#dbd9d5',
  accent: '#c2603f',
  borderStrong: '#d5d2cd',
};

let cached: CanvasTheme | null = null;

function readTokens(): CanvasTheme {
  let styles: CSSStyleDeclaration;
  try {
    // Guarded by try/catch rather than by a `typeof document` test: in a worker
    // or offscreen context `document` does not exist at all and referencing it
    // is a ReferenceError, but the DOM lib types declare it as always present -
    // so a type-level guard is code the compiler (and the linter) can prove is
    // dead, while the runtime failure is entirely real.
    styles = getComputedStyle(document.documentElement);
  } catch {
    return FALLBACK;
  }

  const read = (token: string, fallback: string): string => {
    const value = styles.getPropertyValue(token).trim();
    return value.length > 0 ? value : fallback;
  };

  return {
    background: read(TOKENS.background, FALLBACK.background),
    dot: read(TOKENS.dot, FALLBACK.dot),
    accent: read(TOKENS.accent, FALLBACK.accent),
    borderStrong: read(TOKENS.borderStrong, FALLBACK.borderStrong),
  };
}

export function getCanvasTheme(): CanvasTheme {
  cached ??= readTokens();
  return cached;
}

/** Call after flipping `data-theme`, then mark the renderer dirty. */
export function refreshTheme(): void {
  cached = null;
}

/** Exposed for tests and for export paths that must not depend on a document. */
export const FALLBACK_THEME: CanvasTheme = FALLBACK;
