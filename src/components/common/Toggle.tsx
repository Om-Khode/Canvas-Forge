import { useId } from 'react';
import { cn } from '@/utils/cn';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Secondary line under the label - for settings rows. */
  description?: string;
  hideLabel?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /**
   * `dialog` is the default: a settings row that owns its line, so the label
   * carries full-strength ink at body size.
   *
   * `field` matches the properties panel, where every label - `NumberField`,
   * `Select`, `ColorField` - is small muted uppercase and the section headings
   * are the same size again. A dialog-weight label there outranks the heading
   * above it and reads as the loudest thing in the panel.
   */
  tone?: 'dialog' | 'field';
  className?: string;
  id?: string;
}

const TRACK_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'h-4 w-7',
  md: 'h-5 w-9',
};

const THUMB_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'size-3',
  md: 'size-4',
};

const THUMB_OFFSET: Record<'sm' | 'md', string> = {
  sm: 'translate-x-3',
  md: 'translate-x-4',
};

const LABEL_CLASSES: Record<'dialog' | 'field', string> = {
  dialog: 'text-ink text-[0.8125rem] leading-tight font-medium',
  field: 'text-ink-muted text-[0.6875rem] font-medium tracking-wide uppercase',
};

const DESCRIPTION_CLASSES: Record<'dialog' | 'field', string> = {
  dialog: 'text-ink-muted text-[0.75rem] leading-snug',
  field: 'text-ink-muted text-[0.6875rem] leading-snug normal-case',
};

/**
 * A switch - a setting that takes effect immediately (snap to grid, lock a
 * layer), never a form value you submit later. That's the distinction between
 * `role="switch"` and a checkbox, and it's why this isn't an `<input>`.
 *
 * It is a `<button>`, so Space and Enter already activate it and the browser
 * handles the keyboard entirely. `aria-checked` carries the state; the thumb's
 * position carries it visually, so the control still reads as on or off with no
 * colour perception at all.
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  hideLabel = false,
  disabled = false,
  size = 'md',
  tone = 'dialog',
  className,
  id,
}: ToggleProps) {
  const generatedId = useId();
  const toggleId = id ?? generatedId;
  const labelId = `${toggleId}-label`;
  const descriptionId = `${toggleId}-description`;

  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span className={cn('flex min-w-0 flex-col gap-0.5', hideLabel && 'sr-only')}>
        <span id={labelId} className={LABEL_CLASSES[tone]}>
          {label}
        </span>
        {description !== undefined && (
          <span id={descriptionId} className={DESCRIPTION_CLASSES[tone]}>
            {description}
          </span>
        )}
      </span>

      <button
        id={toggleId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        disabled={disabled}
        onClick={() => {
          onChange(!checked);
        }}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-full p-0.5',
          'transition-colors duration-160 ease-out',
          'disabled:pointer-events-none disabled:opacity-45',
          TRACK_CLASSES[size],
          checked ? 'bg-accent' : 'bg-surface-3 hover:bg-edge-strong'
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'bg-toggle-thumb shadow-panel rounded-full transition-transform duration-160 ease-out',
            THUMB_CLASSES[size],
            checked ? THUMB_OFFSET[size] : 'translate-x-0'
          )}
        />
      </button>
    </div>
  );
}
