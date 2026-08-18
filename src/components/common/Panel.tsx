import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface PanelProps {
  title?: string;
  /** Buttons in the header's trailing slot - collapse, add, overflow menu. */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /**
   * Panels are landmarks: the layers and properties panels are `aside`, a
   * grouping inside a dialog is `section`. The tag is a semantic decision the
   * caller owns, so it's a prop rather than a fixed `div`.
   */
  as?: 'aside' | 'section' | 'div';
  /** Off when the panel's own children manage scrolling (a virtual list). */
  scroll?: boolean;
  /** Removes the frame - for a panel docked flush against a window edge. */
  bare?: boolean;
  className?: string;
  bodyClassName?: string;
}

/**
 * The frame every docked panel sits in: header, scrolling body, optional
 * footer.
 *
 * Exists so the layers panel and the properties panel cannot drift apart. The
 * moment those two are built separately, one gets 12px of padding and the other
 * 16px, one's header is 40px and the other's 44px, and the editor stops looking
 * like it was designed. Consistency here is not tidiness - it's the difference
 * between "product" and "demo".
 *
 * The body owns the scroll, not the panel, so the header stays put while the
 * content moves - the behaviour anyone expects from a docked panel.
 */
export function Panel({
  title,
  actions,
  footer,
  children,
  as: Tag = 'section',
  scroll = true,
  bare = false,
  className,
  bodyClassName,
}: PanelProps) {
  const hasHeader = title !== undefined || actions !== undefined;

  return (
    <Tag
      aria-label={title}
      className={cn(
        'flex min-h-0 flex-col',
        bare ? 'bg-surface-1' : 'bg-surface-1 border-edge rounded-panel shadow-panel border',
        className
      )}
    >
      {hasHeader && (
        <header
          className={cn(
            'border-edge flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3',
            // Matches the panel's own corner so the header's tint doesn't square
            // off the top edge.
            !bare && 'rounded-t-panel'
          )}
        >
          {title !== undefined && (
            <h2 className="text-ink-soft truncate text-[0.6875rem] font-semibold tracking-wider uppercase">
              {title}
            </h2>
          )}
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
          )}
        </header>
      )}

      <div
        className={cn(
          'min-h-0 flex-1',
          scroll && 'overflow-y-auto overscroll-contain',
          bodyClassName
        )}
      >
        {children}
      </div>

      {footer !== undefined && (
        <footer className="border-edge flex shrink-0 items-center gap-2 border-t px-3 py-2">
          {footer}
        </footer>
      )}
    </Tag>
  );
}

export interface PanelSectionProps {
  /** Optional group heading inside a panel body - "Position", "Appearance". */
  title?: string;
  children: ReactNode;
  className?: string;
}

/**
 * A titled group inside a panel body. Separated by a rule rather than a card,
 * because nesting cards inside a panel adds a border and a shadow to say
 * something a 1px line already says.
 */
export function PanelSection({ title, children, className }: PanelSectionProps) {
  return (
    <section
      className={cn(
        'border-edge flex flex-col gap-2.5 border-b px-3 py-3 last:border-b-0',
        className
      )}
    >
      {title !== undefined && (
        <h3 className="text-ink-muted text-[0.6875rem] font-semibold tracking-wider uppercase">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}
