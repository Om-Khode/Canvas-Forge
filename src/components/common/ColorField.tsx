import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { SWATCHES } from '@/constants';
import { useOnClickOutside } from '@/hooks/useOnClickOutside';
import { cn } from '@/utils/cn';

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const POPOVER_WIDTH_PX = 220;
const GAP_PX = 6;
const MARGIN_PX = 8;

/** `#ABC` → `#aabbcc`. Returns null for anything that isn't a hex colour. */
function normalizeHex(input: string): string | null {
  const match = HEX_PATTERN.exec(input.trim());
  if (match === null) return null;
  const digits = match[1] ?? '';
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((character) => character + character)
          .join('')
      : digits;
  return `#${full.toLowerCase()}`;
}

export interface ColorFieldProps {
  label: string;
  /** `null` is "no fill" - a real, selectable state, not a missing value. */
  value: string | null;
  onChange: (value: string | null) => void;
  allowTransparent?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  className?: string;
}

/** The swatch face: a solid fill, or a slashed tile when there's no fill. */
function SwatchFace({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('border-edge-strong block overflow-hidden rounded-[0.25rem] border', className)}
      style={
        color === null
          ? {
              // The universal "none" tile: a hairline through an empty square.
              // A checkerboard would read as "transparent pixels" - a different
              // idea from "this shape has no fill at all".
              backgroundImage:
                'linear-gradient(to top right, transparent calc(50% - 1px), var(--cf-border-strong) calc(50% - 1px), var(--cf-border-strong) calc(50% + 1px), transparent calc(50% + 1px))',
            }
          : { backgroundColor: color }
      }
    />
  );
}

/**
 * Colour picker: a swatch that opens a popover with the project palette, the
 * OS colour picker, and a hex field.
 *
 * The palette comes first because it's the answer 90% of the time and it's what
 * keeps a document looking coherent; the native input and the hex field are the
 * escape hatches. The popover is portalled and fixed-positioned so it can't be
 * clipped by the properties panel's own scroll container.
 */
export function ColorField({
  label,
  value,
  onChange,
  allowTransparent = false,
  disabled = false,
  hideLabel = false,
  className,
}: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  /**
   * Null means "show whatever the current colour is". Holding the draft as an
   * *absence* rather than a copy is what keeps the hex field in sync after a
   * swatch click without an effect mirroring one piece of state into another.
   */
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useOnClickOutside(
    [triggerRef, popoverRef],
    () => {
      setOpen(false);
    },
    open
  );

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      const height = popoverRef.current?.offsetHeight ?? 0;
      const below = rect.bottom + GAP_PX;
      // Flip above when the popover would run off the bottom, then clamp so it
      // never sits under the right edge of a narrow window.
      const top =
        below + height > window.innerHeight - MARGIN_PX ? rect.top - height - GAP_PX : below;
      const left = Math.min(rect.left, window.innerWidth - POPOVER_WIDTH_PX - MARGIN_PX);
      setPosition({ top: Math.max(MARGIN_PX, top), left: Math.max(MARGIN_PX, left) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  /**
   * "No fill" is just another swatch in the grid, not a special case beside it.
   * One list means one keyboard order, one selected-state rule, and one place
   * that can be wrong.
   */
  const choices: readonly (string | null)[] = allowTransparent ? [...SWATCHES, null] : SWATCHES;

  /** Valid hex is applied; anything else silently reverts to the live value. */
  const commitHex = (raw: string): void => {
    const normalized = normalizeHex(raw);
    setHexDraft(null);
    if (normalized !== null) onChange(normalized);
  };

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'text-ink-muted text-[0.6875rem] font-medium tracking-wide uppercase',
          hideLabel && 'sr-only'
        )}
      >
        {label}
      </span>

      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The current colour is part of the name, not a separate description:
        // "Fill, #c2603f" is one useful announcement, and `aria-description`
        // still isn't reliably supported.
        aria-label={`${label}: ${value ?? 'No fill'}`}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
        className={cn(
          'border-edge bg-field rounded-field flex h-7 min-w-0 flex-1 items-center gap-2 border px-1.5',
          'transition-colors duration-120 ease-out',
          'not-focus-within:hover:border-edge-strong disabled:pointer-events-none disabled:opacity-50',
          open && 'border-accent'
        )}
      >
        <SwatchFace color={value} className="size-4 shrink-0" />
        <span className="text-ink truncate text-[0.8125rem] tabular-nums">
          {value ?? 'No fill'}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={`${label} colour`}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              // Consumed so Escape dismisses this popover only - a dialog
              // hosting the properties panel stays open.
              event.stopPropagation();
              close();
            }}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              width: POPOVER_WIDTH_PX,
              visibility: position === null ? 'hidden' : 'visible',
            }}
            className="bg-surface-1 border-edge rounded-panel animate-pop-in shadow-popover fixed z-50 flex flex-col gap-3 border p-3 outline-none"
          >
            <div className="grid grid-cols-5 gap-1.5">
              {choices.map((choice) => {
                const selected = (value?.toLowerCase() ?? null) === choice;
                return (
                  <button
                    key={choice ?? 'none'}
                    type="button"
                    aria-label={choice ?? 'No fill'}
                    aria-pressed={selected}
                    onClick={() => {
                      onChange(choice);
                    }}
                    className="relative flex size-8 items-center justify-center rounded-[0.3125rem] transition-transform duration-120 hover:scale-105"
                  >
                    <SwatchFace color={choice} className="size-full" />
                    {selected && (
                      <Check
                        size={14}
                        strokeWidth={3}
                        aria-hidden="true"
                        // A tick drawn straight onto the swatch would be
                        // invisible on half the palette, so it sits on a chip of
                        // page colour instead.
                        className="text-ink bg-surface-1 absolute rounded-full p-px"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="border-edge flex items-center gap-2 border-t pt-3">
              <input
                type="color"
                aria-label="Custom colour"
                value={value ?? '#000000'}
                onChange={(event) => {
                  onChange(event.target.value);
                }}
                className="border-edge size-7 shrink-0 cursor-pointer rounded-[0.3125rem] border bg-transparent p-0.5"
              />
              <input
                type="text"
                aria-label="Hex value"
                spellCheck={false}
                value={hexDraft ?? value ?? ''}
                placeholder="#000000"
                onChange={(event) => {
                  setHexDraft(event.target.value);
                }}
                onBlur={(event) => {
                  commitHex(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitHex(event.currentTarget.value);
                }}
                className="border-edge bg-field rounded-field text-ink placeholder:text-ink-muted focus:border-accent h-7 min-w-0 flex-1 border px-2 font-mono text-[0.75rem] outline-none"
              />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
