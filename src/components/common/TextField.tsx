import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export type TextFieldSize = 'sm' | 'md';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size'
> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * Fired on Enter and on blur. Use it for edits that shouldn't hit the store
   * per keystroke - renaming a layer, renaming a project.
   */
  onCommit?: (value: string) => void;
  /** Fired on Escape, for callers that revert. */
  onCancel?: () => void;
  hideLabel?: boolean;
  icon?: LucideIcon;
  fieldSize?: TextFieldSize;
  invalid?: boolean;
  /** Help text below the field; announced via `aria-describedby`. */
  hint?: string;
}

const SIZE_CLASSES: Record<TextFieldSize, string> = {
  sm: 'h-7 text-[0.8125rem]',
  md: 'h-9 text-sm',
};

/**
 * Single-line text input.
 *
 * Fully controlled - unlike NumberField, an intermediate string is a perfectly
 * valid name, so there is nothing to protect the store from and no reason to
 * hold a second copy of the value. `onCommit` exists for the callers that want
 * a coarser write, not because typing needs buffering.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    value,
    onChange,
    onCommit,
    onCancel,
    hideLabel = false,
    icon: Icon,
    fieldSize = 'md',
    invalid = false,
    hint,
    disabled,
    className,
    id,
    onKeyDown,
    onBlur,
    ...rest
  },
  ref
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label
        htmlFor={inputId}
        className={cn(
          'text-ink-muted text-[0.6875rem] font-medium tracking-wide uppercase',
          hideLabel && 'sr-only'
        )}
      >
        {label}
      </label>

      <div
        className={cn(
          'rounded-field flex min-w-0 items-center border transition-colors duration-120 ease-out',
          'bg-field focus-within:bg-surface-1',
          invalid
            ? 'border-danger'
            : 'border-edge focus-within:border-accent not-focus-within:hover:border-edge-strong',
          disabled === true && 'pointer-events-none opacity-50',
          SIZE_CLASSES[fieldSize]
        )}
      >
        {Icon !== undefined && (
          <Icon
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="text-ink-muted ml-2 shrink-0"
          />
        )}
        <input
          ref={ref}
          id={inputId}
          type="text"
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onBlur={(event) => {
            onCommit?.(event.target.value);
            onBlur?.(event);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCommit?.(event.currentTarget.value);
            } else if (event.key === 'Escape' && onCancel !== undefined) {
              // Only swallowed when the caller has something to revert;
              // otherwise Escape belongs to whatever dialog is above us.
              event.stopPropagation();
              onCancel();
            }
            onKeyDown?.(event);
          }}
          className={cn(
            'text-ink placeholder:text-ink-muted min-w-0 flex-1 bg-transparent px-2 outline-none'
          )}
          {...rest}
        />
      </div>

      {hint !== undefined && (
        <p
          id={hintId}
          className={cn('text-[0.6875rem]', invalid ? 'text-danger' : 'text-ink-muted')}
        >
          {hint}
        </p>
      )}
    </div>
  );
});
