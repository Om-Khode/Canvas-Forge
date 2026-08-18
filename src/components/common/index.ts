/**
 * The editor's UI vocabulary.
 *
 * Everything here is presentational and prop-driven - nothing imports the
 * store. That is a deliberate boundary: a primitive that reaches into global
 * state can't be reused in a second context, can't be tested without standing
 * the store up, and quietly makes every panel depend on the shape of a slice.
 * Panels wire these to the store; the primitives never know it exists.
 */

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export {
  IconButton,
  type IconButtonProps,
  type IconButtonSize,
  type IconButtonVariant,
} from './IconButton';
export { Tooltip, type TooltipProps, type TooltipSide } from './Tooltip';
export { Dialog, type DialogProps, type DialogSize } from './Dialog';
export { NumberField, type NumberFieldProps } from './NumberField';
export { TextField, type TextFieldProps, type TextFieldSize } from './TextField';
export { ColorField, type ColorFieldProps } from './ColorField';
export { Select, type SelectOption, type SelectProps } from './Select';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './SegmentedControl';
export { Toggle, type ToggleProps } from './Toggle';
export { Kbd, formatShortcut, IS_MAC, type KbdProps } from './Kbd';
export { Panel, PanelSection, type PanelProps, type PanelSectionProps } from './Panel';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Logo, LogoMark, type LogoProps, type LogoMarkProps } from './Logo';
