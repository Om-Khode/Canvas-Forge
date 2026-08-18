import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';

import { IconButton, Logo } from '@/components/common';
import { MAX_ZOOM, MIN_ZOOM } from '@/constants';
import { useTheme } from '@/hooks/useTheme';
import { HeroDemo } from './landing/HeroDemo';

/*
  The door, not the room.

  Two rules held this page down. **Nothing is claimed that the editor does not
  do** - the zoom range below is read from the same constants the canvas clamps
  to, so the copy cannot drift from the product. And **nothing is decorative that
  could be real**: the panel on the right is a working fragment of the editor
  rather than a screenshot, and its readouts report the rectangle's actual size
  and position rather than standing in for them.

  There is no navigation to documentation that is not hosted and no link to a
  repository that may not be public. An empty nav bar is more honest than one
  that 404s.
*/

const FEATURES = [
  {
    label: 'Infinite canvas',
    body: `Cursor-anchored zoom from ${Math.round(MIN_ZOOM * 100)}% to ${MAX_ZOOM * 100}%, with fit and reset.`,
  },
  {
    label: 'Real editing',
    body: 'Multi-select, rotate, align, distribute, reorder layers, and undo any of it.',
  },
  {
    label: 'Local-first',
    body: 'Autosaved to IndexedDB. Refresh, close the tab, come back - it is still there.',
  },
  {
    label: 'Export anywhere',
    body: 'PNG and SVG out, plus versioned JSON that imports straight back in.',
  },
] as const;

/*
  The page is pinned to the viewport under one condition: the split layout is
  showing *and* there is room for the copy beside it.

  The query is spelled out at each site rather than built from a constant,
  because Tailwind scans source text - a class assembled from a variable is a
  class it never generates, and the rule would silently not exist.
*/

const PRIMARY_LINK =
  'inline-flex h-10 items-center justify-center rounded-control bg-accent px-5 text-sm font-medium ' +
  'text-accent-fg transition-colors duration-120 ease-out hover:bg-accent-hover';

const SECONDARY_LINK =
  'inline-flex h-10 items-center justify-center rounded-control border border-edge-strong ' +
  'bg-surface-1 px-5 text-sm font-medium text-ink transition-colors duration-120 ease-out hover:bg-surface-2';

export function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    /*
      The page is pinned to the viewport only when the viewport can actually
      hold it - wide enough for the split layout *and* tall enough for the copy.
      Pinning unconditionally was worse than the scrollbar it removed: on a short
      window the column overflowed and the heading was clipped against the
      header with no way to scroll to it.

      Outside that window the page scrolls like any other document, which is the
      right behaviour for a phone and for a laptop with a very short viewport.
      The query is spelled out at each site rather than built from a constant,
      because Tailwind scans source text: a class assembled from a variable is a
      class it never generates, and the rule would silently not exist.
    */
    <div className="bg-surface-0 flex min-h-dvh flex-col [@media(min-width:64rem)_and_(min-height:44rem)]:h-dvh [@media(min-width:64rem)_and_(min-height:44rem)]:overflow-hidden">
      <header className="border-edge flex h-16 shrink-0 items-center justify-between border-b px-5 sm:px-8">
        <Logo />
        <div className="flex items-center gap-2">
          <IconButton
            icon={theme === 'dark' ? Sun : Moon}
            label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            size="sm"
            tooltipSide="bottom"
            onClick={toggleTheme}
          />
          <Link to="/editor" className={`${PRIMARY_LINK} hidden h-9 px-4 sm:inline-flex`}>
            Start creating
          </Link>
        </div>
      </header>

      {/*
        The split is a real border rather than a background change, and the demo
        column keeps its own height at `lg`. Below that it stacks: a 400px-tall
        canvas under the copy still demonstrates the interaction, where a
        squeezed two-column layout would demonstrate neither half.
      */}
      <main className="flex flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] [@media(min-width:64rem)_and_(min-height:44rem)]:min-h-0">
        <section className="flex px-5 py-12 sm:px-8 lg:py-10 xl:px-16">
          {/*
            Centred with `m-auto` on the inner block rather than `justify-center`
            on the flex parent. They look identical until the content is taller
            than the column, at which point `justify-center` pushes the overflow
            out of *both* ends and the top of the heading becomes unreachable -
            clipped, with no scroll position that can reveal it. `auto` margins
            collapse to zero on the overflowing side instead.
          */}
          <div className="m-auto w-full">
            {/*
            `text-balance` rather than a hand-placed <br>: a forced break is
            correct at exactly one column width and ragged at every other, and
            this heading is read across a fluid two-column grid.
          */}
            <h1 className="text-ink max-w-[16ch] text-[2.25rem] leading-[1.05] font-semibold tracking-[-0.04em] text-balance sm:text-[2.875rem]">
              An infinite canvas that runs entirely in your browser.
            </h1>

            <p className="text-ink-soft mt-4 max-w-md text-base leading-relaxed">
              Shapes, text, images, layers, undo history and export - all client-side, and all in
              plain serializable JSON.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link to="/editor" className={PRIMARY_LINK}>
                Start creating
              </Link>
              <Link to="/editor?demo=1" className={SECONDARY_LINK}>
                Try the demo
              </Link>
            </div>

            <dl className="mt-10 grid max-w-lg grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
              {FEATURES.map(({ label, body }, index) => (
                <div key={label}>
                  <dt className="flex items-baseline gap-2">
                    <span className="text-accent font-mono text-[0.6875rem] tabular-nums">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="text-ink text-[0.8125rem] font-semibold tracking-wide uppercase">
                      {label}
                    </span>
                  </dt>
                  <dd className="text-ink-muted mt-1.5 text-[0.8125rem] leading-relaxed">{body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section
          aria-label="Interactive preview"
          className="border-edge flex min-h-[26rem] flex-col border-t lg:min-h-0 lg:border-t-0 lg:border-l"
        >
          <HeroDemo />
        </section>
      </main>
    </div>
  );
}
