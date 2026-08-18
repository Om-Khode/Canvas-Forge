import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  hideLabel?: boolean;
  disabled?: boolean;
  fieldSize?: 'sm' | 'md';
  className?: string;
  id?: string;
}

const SIZE_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'h-7 pl-2 pr-7 text-[0.8125rem]',
  md: 'h-9 pl-2.5 pr-8 text-sm',
};

/**
 * A real `<select>`, restyled.
 *
 * A custom listbox would let the font-family dropdown render each option in its
 * own typeface - genuinely nice - but it costs a popup, positioning, typeahead,
 * roving focus, and a screen-reader implementation, all of which the platform
 * already ships and gets right. It also gets the native picker on touch, which
 * is materially better than anything reimplemented here.
 *
 * The only thing worth writing is the chrome: the native arrow is suppressed
 * and replaced with a lucide chevron so it matches every other icon in the app.
 * `generic` typing keeps `onChange` narrowed to the union the caller passed, so
 * a stray value is a compile error rather than a runtime surprise.
 */
export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  hideLabel = false,
  disabled = false,
  fieldSize = 'md',
  className,
  id,
}: SelectProps<T>) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label
        htmlFor={selectId}
        className={cn(
          'text-ink-muted text-[0.6875rem] font-medium tracking-wide uppercase',
          hideLabel && 'sr-only'
        )}
      >
        {label}
      </label>

      <div className="relative flex min-w-0 items-center">
        <select
          id={selectId}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value as T);
          }}
          className={cn(
            'border-edge bg-field rounded-field text-ink w-full min-w-0 appearance-none border',
            'cursor-pointer truncate transition-colors duration-120 ease-out',
            'not-focus:hover:border-edge-strong focus:border-accent',
            'disabled:pointer-events-none disabled:opacity-50',
            SIZE_CLASSES[fieldSize]
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled ?? false}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className="text-ink-muted pointer-events-none absolute right-2"
        />
      </div>
    </div>
  );
}
