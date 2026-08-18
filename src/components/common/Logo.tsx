import { cn } from '@/utils/cn';

/*
  The mark: a rounded square cut by a diagonal, one half light and one half
  forged orange, with a hairline second cut through the light half.

  Drawn as geometry rather than shipped as a raster for three reasons that all
  matter here: it is a handful of polygons so it costs less than a PNG, it stays
  sharp at 16px and at 512px from one definition, and - the reason that decides
  it - the light half is `currentColor`. A fixed white mark would vanish against
  the light theme, and maintaining two files is how a logo drifts. The orange is
  literal because it is the brand; the other half belongs to the page.
*/

/** Bands are expressed as `x + y = c`, which is a line running lower-left to upper-right. */
const HAIRLINE = { from: 13.15, to: 13.65 };
const MAIN_CUT = { from: 22.85, to: 25.15 };

/** A parallelogram covering everything between two `x + y` lines. Clipped by the frame. */
function band(from: number, to: number): string {
  return `${from + 12},-12 -12,${from + 12} -12,${to + 12} ${to + 12},-12`;
}

/** Everything below-right of a line. */
function beyond(line: number): string {
  return `${line + 12},-12 -12,${line + 12} -12,40 40,40 40,-12`;
}

export interface LogoMarkProps {
  /** Rendered size in pixels. */
  size?: number;
  className?: string;
  /**
   * Paints the dark plinth the standalone logo sits on. Off inside the app,
   * where the mark sits directly on the page; on for the favicon and OG image,
   * which have no page behind them.
   */
  plinth?: boolean;
}

export function LogoMark({ size = 24, className, plinth = false }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id="cf-forge" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stopColor="#F2872F" />
          <stop offset="100%" stopColor="#DC4F16" />
        </linearGradient>
        <clipPath id="cf-frame">
          <rect x="1" y="1" width="22" height="22" rx="3.6" />
        </clipPath>
      </defs>

      {plinth && <rect width="24" height="24" rx="5.2" fill="#121215" />}

      <g clipPath="url(#cf-frame)">
        {/* The light half takes the page's ink colour so the mark reads in both themes. */}
        <rect x="1" y="1" width="22" height="22" fill="currentColor" />
        <polygon points={beyond(MAIN_CUT.to)} fill="url(#cf-forge)" />
        {/* The cuts are the plinth showing through, so they are painted, not gaps. */}
        <polygon points={band(MAIN_CUT.from, MAIN_CUT.to)} fill={plinth ? '#121215' : 'var(--cf-surface-0)'} />
        <polygon
          points={band(HAIRLINE.from, HAIRLINE.to)}
          fill={plinth ? '#121215' : 'var(--cf-surface-0)'}
        />
      </g>
    </svg>
  );
}

export interface LogoProps {
  size?: number;
  className?: string;
  /** Hide the wordmark, leaving the mark alone. */
  markOnly?: boolean;
}

/** Mark plus wordmark, as one accessible unit. */
export function Logo({ size = 22, className, markOnly = false }: LogoProps) {
  return (
    <span className={cn('text-ink flex items-center gap-2', className)}>
      <LogoMark size={size} />
      {!markOnly && (
        <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">CanvasForge</span>
      )}
      {markOnly && <span className="sr-only">CanvasForge</span>}
    </span>
  );
}
