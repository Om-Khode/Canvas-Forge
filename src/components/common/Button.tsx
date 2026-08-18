import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Swaps the leading slot for a spinner and blocks interaction. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

/*
  Every variant is a *border + surface* pair, never a gradient. The editor
  chrome has to disappear behind the user's artwork; the only saturated thing
  on screen should be what they drew. Primary is the one exception, and there
  is at most one primary button visible at a time.

  Transitions cover colour only. Transforms on press look playful in isolation
  and read as lag in a tool you click three hundred times an hour.
*/
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg border-transparent hover:bg-accent-hover active:bg-accent-hover',
  secondary: 'bg-surface-1 text-ink border-edge-strong hover:bg-surface-2 active:bg-surface-3',
  ghost:
    'bg-transparent text-ink-soft border-transparent hover:bg-surface-2 hover:text-ink active:bg-surface-3',
  danger:
    'bg-danger text-danger-fg border-transparent hover:bg-danger-hover active:bg-danger-hover',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[0.8125rem]',
  md: 'h-9 gap-2 px-3.5 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconLeft,
    iconRight,
    fullWidth = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const isDisabled = disabled === true || loading;

  return (
    <button
      ref={ref}
      // Defaulting to "button" rather than the HTML default "submit": a button
      // inside the export dialog's form should not submit it by accident.
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'rounded-control inline-flex shrink-0 items-center justify-center border',
        'font-medium whitespace-nowrap transition-colors duration-120 ease-out select-none',
        'disabled:pointer-events-none disabled:opacity-45',
        SIZE_CLASSES[size],
        VARIANT_CLASSES[variant],
        fullWidth && 'w-full',
        className
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle
          size={size === 'sm' ? 14 : 16}
          strokeWidth={2}
          className="animate-spin"
          aria-hidden="true"
        />
      ) : (
        iconLeft
      )}
      {children}
      {iconRight}
    </button>
  );
});
