import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { DRAG_THRESHOLD_PX } from '@/constants';
import { cn } from '@/utils/cn';

/** Screen pixels of pointer travel per `step`. Slow enough to land on a value. */
const PX_PER_STEP = 2;
const COARSE_MULTIPLIER = 10;
const FINE_MULTIPLIER = 0.1;

export interface NumberFieldProps {
  /** Short label - also the scrub handle. `x`, `W`, `Rotation`. */
  label: string;
  /** `null` means "multiple values" across a multi-selection. */
  value: number | null;
  onChange: (value: number) => void;
  /** Bracket a scrub so the store can wrap it in one history transaction. */
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown. Scrubbing a rotation to 12.0000001° helps nobody. */
  precision?: number;
  /** Suffix rendered inside the field: `px`, `°`, `%`. */
  unit?: string;
  disabled?: boolean;
  hideLabel?: boolean;
  className?: string;
  id?: string;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const format = (value: number, precision: number): string =>
  // `Number()` strips the trailing zeros `toFixed` insists on, so 12 reads as
  // "12" and 12.5 as "12.5" in the same field.
  String(Number(value.toFixed(precision)));

/**
 * The properties panel's workhorse: a number input with a drag-to-scrub label.
 *
 * Two behaviours are worth the code.
 *
 * **It stays locally controlled while focused.** Typing "100" into a field
 * showing 20 passes through "1" and "10". A naively controlled input pushes
 * each of those to the store, so the shape on canvas snaps to 1px wide, then
 * 10px, and - because each write is a transaction - the user gets three undo
 * entries for one edit. So keystrokes go to a local draft; the store hears one
 * committed value on blur or Enter, and Escape throws the draft away.
 *
 * **The label scrubs.** Dragging a label is how every design tool sets a
 * number, and it's the difference between a demo and something usable. Shift
 * coarsens ×10, Alt refines ×0.1, matching the modifier convention of the tools
 * this sits next to.
 */
export function NumberField({
  label,
  value,
  onChange,
  onScrubStart,
  onScrubEnd,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  precision = 2,
  unit,
  disabled = false,
  hideLabel = false,
  className,
  id,
}: NumberFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const inputRef = useRef<HTMLInputElement>(null);

  /** Non-null only while the user is typing. Null means "mirror `value`". */
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const isMixed = value === null;
  const displayed = draft ?? (isMixed ? '' : format(value, precision));

  const commit = useCallback(
    (raw: string) => {
      const parsed = Number.parseFloat(raw);
      // An unparseable or empty field reverts rather than writing NaN - the
      // element model has no representation for "the user deleted the width".
      if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max));
      setDraft(null);
    },
    [onChange, min, max]
  );

  const nudge = useCallback(
    (direction: 1 | -1, event: { shiftKey: boolean; altKey: boolean }) => {
      if (isMixed) return;
      const multiplier = event.shiftKey ? COARSE_MULTIPLIER : event.altKey ? FINE_MULTIPLIER : 1;
      const next = clamp(value + direction * step * multiplier, min, max);
      setDraft(format(next, precision));
      onChange(next);
    },
    [isMixed, value, step, min, max, precision, onChange]
  );

  /**
   * Scrub state lives in a ref, not React state: pointermove fires far faster
   * than React can usefully re-render, and the drag's origin must not be
   * recreated by a render in the middle of it.
   */
  const scrubRef = useRef<{ startX: number; startValue: number; moved: boolean } | null>(null);

  /**
   * The drag effect must depend on `scrubbing` and nothing else. Callers pass
   * inline arrows for `onChange`, so listing it as a dependency would tear down
   * and rebuild the listeners on every render *during* the drag - and the
   * cursor save/restore in that effect would then save the cursor it had just
   * set, leaving the page stuck on `ew-resize` forever. A latest-value ref
   * keeps the handlers current without re-subscribing.
   */
  const latest = useRef({ onChange, onScrubEnd, step, min, max });
  useEffect(() => {
    latest.current = { onChange, onScrubEnd, step, min, max };
  });

  const beginScrub = useCallback(
    (event: ReactPointerEvent<HTMLLabelElement>) => {
      if (disabled || isMixed || event.button !== 0) return;
      // Deliberately no preventDefault: the label keeps its `for` behaviour, so
      // a plain *click* still focuses the input for typing. Only a real drag is
      // intercepted, below.
      scrubRef.current = { startX: event.clientX, startValue: value, moved: false };
      setScrubbing(true);
      onScrubStart?.();
    },
    [disabled, isMixed, value, onScrubStart]
  );

  /*
    Move/up are bound to `window` rather than using `setPointerCapture`.
    Capture is the tidier API, but it retargets events to the captured element,
    and the label is a 20px target the pointer leaves within the first frame of
    any real drag; window listeners make "the drag continues wherever the mouse
    goes, including outside the browser window" the default rather than a
    special case.
  */
  useEffect(() => {
    if (!scrubbing) return;

    const onMove = (event: PointerEvent): void => {
      const origin = scrubRef.current;
      if (origin === null) return;
      const { onChange: change, step: stepSize, min: lower, max: upper } = latest.current;
      const travel = event.clientX - origin.startX;
      if (Math.abs(travel) >= DRAG_THRESHOLD_PX) origin.moved = true;
      const multiplier = event.shiftKey ? COARSE_MULTIPLIER : event.altKey ? FINE_MULTIPLIER : 1;
      change(
        clamp(origin.startValue + (travel / PX_PER_STEP) * stepSize * multiplier, lower, upper)
      );
    };

    /**
     * Ends the gesture for the caller, at most once.
     *
     * `onScrubEnd` commits a history transaction and releases whatever the
     * caller froze at `onScrubStart`, so running it twice for one gesture would
     * close a transaction this drag never opened - whichever unrelated one
     * happens to be open by then. The live scrub origin is the flag: it is
     * cleared *before* the callback, because `onScrubEnd` writes to the store and
     * may re-render or unmount this field, and any re-entrant release has to
     * find the gesture already gone.
     */
    const release = (): void => {
      if (scrubRef.current === null) return;
      scrubRef.current = null;
      latest.current.onScrubEnd?.();
    };

    const onUp = (): void => {
      // A drag that ends over the label would otherwise fire a click, which the
      // label forwards to the input - focusing and selecting a field the user
      // was only dragging. Swallow exactly that one click, then stop listening
      // on the next tick so a later, unrelated click is never eaten.
      if (scrubRef.current?.moved === true) {
        const swallow = (event: MouseEvent): void => {
          event.preventDefault();
          event.stopPropagation();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        window.setTimeout(() => {
          window.removeEventListener('click', swallow, true);
        }, 0);
      }
      release();
      setScrubbing(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // The cursor has to survive leaving the label, and text selection has to
    // stop, for the whole drag - both are document-level facts, not label ones.
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      /*
        Reached with a scrub still live only when the field went away underneath
        the pointer - the selection emptied while the mouse was held, which
        Escape and Delete both do from the keyboard, and the panel swapped this
        section out. No pointerup will ever arrive, so this is the last chance to
        end the gesture, and the caller's transaction would otherwise stay open
        forever: undo is refused while one is, so it would be dead for the rest
        of the session. Every field pays that, which is why the guard lives here
        rather than in the one caller whose frozen state also leaks.

        A no-op on the normal path: `onUp` releases before it clears
        `scrubbing`, so by the time this cleanup runs the ref is already null.
      */
      release();
    };
  }, [scrubbing]);

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <label
        htmlFor={inputId}
        onPointerDown={beginScrub}
        className={cn(
          'text-ink-muted min-w-0 touch-none truncate text-[0.6875rem] font-medium tracking-wide uppercase select-none',
          hideLabel && 'sr-only',
          disabled || isMixed ? 'cursor-default' : 'hover:text-ink-soft cursor-ew-resize',
          scrubbing && 'text-accent'
        )}
      >
        {label}
      </label>

      <div
        className={cn(
          // The floor is on the box, not the input: flexbox shrinks the box to
          // this and then takes the remainder out of the label, which truncates.
          //
          // In a narrow column the label and the value cannot both fit, so one
          // has to give - and it must not be the value. A clipped label still
          // reads, and screen readers get it in full either way, whereas a
          // clipped number is actively wrong: an opacity of 100% rendered as
          // "10" is not a cosmetic problem, it is the field lying about the
          // document. (Found exactly that way - see docs/problems-log.md 002.)
          'border-edge bg-field rounded-field flex h-7 min-w-[4.5rem] flex-1 items-center border',
          'transition-colors duration-120 ease-out',
          'focus-within:border-accent focus-within:bg-surface-1',
          disabled ? 'opacity-50' : 'not-focus-within:hover:border-edge-strong'
        )}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="number"
          inputMode="decimal"
          value={displayed}
          disabled={disabled}
          placeholder={isMixed ? 'Mixed' : undefined}
          step={step}
          aria-label={hideLabel ? label : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onFocus={(event) => {
            setDraft(isMixed ? '' : format(value, precision));
            event.target.select();
          }}
          onBlur={(event) => {
            commit(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(event.currentTarget.value);
            } else if (event.key === 'Escape') {
              // Consumed here so Escape reverts the field instead of closing
              // the dialog or cancelling the canvas interaction behind it.
              event.stopPropagation();
              setDraft(isMixed ? '' : format(value, precision));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              nudge(1, event);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              nudge(-1, event);
            }
          }}
          className={cn(
            'text-ink placeholder:text-ink-muted min-w-0 flex-1 bg-transparent',
            'px-1.5 text-[0.8125rem] tabular-nums outline-none',
            // Spinners are a 12px hit target that duplicates what the arrow
            // keys and the scrub handle already do better.
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
          )}
        />
        {unit !== undefined && (
          <span aria-hidden="true" className="text-ink-muted pr-1.5 text-[0.6875rem] select-none">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
