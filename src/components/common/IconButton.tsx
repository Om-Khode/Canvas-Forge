import { forwardRef, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip, type TooltipSide } from './Tooltip';
import { cn } from '@/utils/cn';

export type IconButtonVariant = 'ghost' | 'solid' | 'danger';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label' | 'title'
> {
  /**
   * The lucide component itself, not an element. Passing the component lets
   * this one place own size and stroke width, which is the difference between
   * a toolbar that looks drawn by one hand and one that doesn't.
   */
  icon: LucideIcon;
  /**
   * Required. Becomes the accessible name *and* the tooltip text - an icon
   * button with no name is unusable with a screen reader and unguessable
   * without one, so the type system asks for it up front.
   */
  label: string;
  /** Platform-neutral chord: shown as keycaps, and exposed as `aria-keyshortcuts`. */
  shortcut?: string;
  /** Toolbar selection state. Rendered as `aria-pressed`, so it is a real toggle. */
  active?: boolean;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  tooltipSide?: TooltipSide;
  /** Off inside a menu row, where the label is already visible next to the icon. */
  tooltip?: boolean;
}

/*
  Square by construction: one dimension token per size drives width, height and
  the icon inside it, so no toolbar button can end up a pixel off its neighbour.
*/
const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: 'size-7 rounded-field',
  md: 'size-9 rounded-control',
  lg: 'size-11 rounded-control',
};

const ICON_SIZE: Record<IconButtonSize, number> = { sm: 15, md: 17, lg: 20 };

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  ghost: 'text-ink-soft hover:bg-surface-2 hover:text-ink active:bg-surface-3',
  solid: 'bg-surface-2 text-ink border border-edge hover:bg-surface-3',
  danger: 'text-ink-soft hover:bg-danger-subtle hover:text-danger active:bg-danger-subtle',
};

/**
 * Active state is a tinted surface plus full-strength ink, never a colour
 * change alone - the selected tool must still read as selected for someone who
 * can't distinguish the accent from the neutral around it.
 */
const ACTIVE_CLASSES = 'bg-accent-subtle text-accent hover:bg-accent-subtle hover:text-accent';

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon: Icon,
    label,
    shortcut,
    active,
    variant = 'ghost',
    size = 'md',
    tooltipSide = 'bottom',
    tooltip = true,
    className,
    disabled,
    type = 'button',
    ...rest
  },
  ref
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      // `aria-pressed` only when the caller opted into toggle semantics -
      // putting it on a plain action button would announce every press as a
      // state change that never happens.
      aria-pressed={active === undefined ? undefined : active}
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        'transition-colors duration-120 ease-out select-none',
        'disabled:pointer-events-none disabled:opacity-40',
        SIZE_CLASSES[size],
        active === true ? ACTIVE_CLASSES : VARIANT_CLASSES[variant],
        className
      )}
      {...rest}
    >
      <Icon size={ICON_SIZE[size]} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );

  if (!tooltip || disabled === true) return button;

  return (
    // linkDescription off: the tooltip repeats the accessible name, and
    // aria-describedby would make a screen reader say it twice. The shortcut
    // travels through aria-keyshortcuts instead.
    <Tooltip
      label={label}
      side={tooltipSide}
      linkDescription={false}
      {...(shortcut !== undefined && { shortcut })}
    >
      {button}
    </Tooltip>
  );
});
