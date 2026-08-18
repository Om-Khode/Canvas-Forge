import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface EmptyStateProps {
  icon: LucideIcon;
  /** What's missing, as a fact - "No layers yet", not "Oops, nothing here!". */
  title: string;
  /** One line saying what to do about it. */
  description?: string;
  action?: ReactNode;
  /** `sm` for inside a docked panel, `md` for a dialog or a full page. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The screen a user sees before they've done anything - so, for many people,
 * the first screen of the product.
 *
 * It is written as an instruction, not an apology. The icon is drawn at low
 * contrast and never in the accent colour: an empty panel should be quiet, and
 * the accent is reserved for things you can act on.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'sm',
  className,
}: EmptyStateProps) {
  const compact = size === 'sm';

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'border-edge text-ink-muted bg-surface-2 flex items-center justify-center rounded-full border',
          compact ? 'size-9' : 'size-12'
        )}
      >
        <Icon size={compact ? 17 : 22} strokeWidth={1.5} />
      </span>

      <div className="flex flex-col gap-1">
        <p className={cn('text-ink font-medium', compact ? 'text-[0.8125rem]' : 'text-sm')}>
          {title}
        </p>
        {description !== undefined && (
          <p
            className={cn(
              'text-ink-muted mx-auto max-w-[28ch] leading-snug',
              compact ? 'text-[0.75rem]' : 'text-[0.8125rem]'
            )}
          >
            {description}
          </p>
        )}
      </div>

      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
