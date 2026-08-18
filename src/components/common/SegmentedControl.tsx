import { useId, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Group name for assistive tech - "Text alignment", "Stroke style". */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Icons only, with the label as the accessible name. For alignment rows. */
  iconOnly?: boolean;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
}

/* Inner heights, chosen so the padded container lands on the same 28/36px
   rhythm as Button and the field primitives. */
const SIZE_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'h-6 text-[0.75rem]',
  md: 'h-8 text-[0.8125rem]',
};

/**
 * A radiogroup that looks like a segmented control.
 *
 * Radio semantics, not a row of toggle buttons: exactly one option is always
 * chosen, which is what `radiogroup` means and what buttons don't say. That
 * choice brings an obligation - a radiogroup is *one* tab stop, and the arrow
 * keys move within it. So the group carries a roving tabindex: the selected
 * option is the only one with `tabIndex=0`, and Arrow/Home/End move selection
 * and focus together, the way native radios behave.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  iconOnly = false,
  size = 'md',
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  const groupId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  const enabled = options.filter((option) => option.disabled !== true);

  /** Selection and focus move together - that's what makes it feel like radios. */
  const select = (next: SegmentedOption<T> | undefined): void => {
    if (next === undefined) return;
    onChange(next.value);
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    // Matched on the dataset rather than an attribute selector so an option
    // value containing quotes or brackets can't produce an invalid selector.
    buttons?.forEach((button) => {
      if (button.dataset['value'] === next.value) button.focus();
    });
  };

  const step = (delta: number): void => {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((option) => option.value === value);
    select(enabled[(current + delta + enabled.length) % enabled.length]);
  };

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={label}
      id={groupId}
      className={cn(
        'bg-surface-2 border-edge rounded-control inline-flex items-center gap-0.5 border p-0.5',
        fullWidth && 'flex w-full',
        className
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            aria-label={iconOnly ? option.label : undefined}
            disabled={option.disabled ?? false}
            // Roving tabindex: Tab enters the group at the current selection,
            // Tab again leaves it. Without this every option is a tab stop and
            // a five-option control costs five presses to walk past.
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(option.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                step(1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                step(-1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                select(enabled[0]);
              } else if (event.key === 'End') {
                event.preventDefault();
                select(enabled[enabled.length - 1]);
              }
            }}
            className={cn(
              'rounded-[0.3125rem] font-medium transition-colors duration-120 ease-out',
              'inline-flex items-center justify-center gap-1.5 select-none',
              'disabled:pointer-events-none disabled:opacity-40',
              iconOnly ? 'aspect-square' : 'px-2.5',
              fullWidth && 'flex-1',
              SIZE_CLASSES[size],
              selected
                ? 'bg-surface-1 text-ink border-edge shadow-panel border'
                : 'text-ink-muted hover:text-ink border border-transparent'
            )}
          >
            {Icon !== undefined && <Icon size={15} strokeWidth={1.75} aria-hidden="true" />}
            {!iconOnly && <span className="truncate">{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
