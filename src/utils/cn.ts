import { clsx, type ClassValue } from 'clsx';

/**
 * Conditional className joiner.
 *
 * Deliberately *not* `tailwind-merge`. Merging costs a parse of every class
 * string on every render and only earns its keep when callers routinely need
 * to override a component's own utilities. The primitives here take the other
 * route: each one puts the consumer's `className` last, and exposes real props
 * (`variant`, `size`, `active`) for the things a caller actually needs to
 * change. Last-wins in the class attribute is not a specificity guarantee, so
 * if you find yourself fighting a base class, the component is missing a prop.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
