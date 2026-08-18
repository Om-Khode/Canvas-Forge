import { NumberField, PanelSection, Toggle } from '@/components/common';
import type { ElementPatch } from '@/features/elements/operations';
import { fieldValue, type PropertyValue } from '@/features/properties/mixed';

const DEGREES_PER_RADIAN = 180 / Math.PI;

/**
 * Declared here rather than imported from a shared props module: the panel
 * supplies one object that satisfies all four sections structurally, so each
 * section can state exactly what it needs without a barrel of prop types that
 * every section then depends on.
 */
export interface PositionSectionProps {
  x: PropertyValue<number>;
  y: PropertyValue<number>;
  width: PropertyValue<number>;
  height: PropertyValue<number>;
  rotation: PropertyValue<number>;
  lockAspect: boolean;
  onLockAspectChange: (locked: boolean) => void;
  /**
   * The box the selection should end up occupying - *not* a promise that these
   * keys are written to the selected elements. With a group in it, "X is now N"
   * translates that group's members and "W is now N" scales them, because its
   * own box is a cache nothing writes (`features/properties/geometry`).
   *
   * One axis per size edit, never a coupled pair. The aspect lock is applied on
   * the write side instead, against the box frozen when the gesture began:
   * computing the other axis *here* would mean reading it back off these props,
   * which during a scrub are the state the previous event produced - the exact
   * drift `onScrubStart` below exists to prevent.
   */
  onChange: (patch: ElementPatch, label: string) => void;
  /**
   * Angle, in **radians**, and deliberately not an `ElementPatch`: "the angle is
   * now N" is not a property assignment for every selection. With a group in it
   * the edit is a rotation of that group about its own centre, applied to its
   * leaves - see `features/properties/rotation`. This section states the number
   * and lets the panel decide what reaching it costs.
   */
  onRotate: (radians: number) => void;
  /**
   * Opens a history transaction for the duration of a scrub - and, like
   * `onRotateScrubStart` below, freezes the state its events are replayed
   * against. A width scrub that re-measured a group's box per event would divide
   * each new target by a box its own previous event changed, and compound.
   */
  onScrubStart: (label: string) => void;
  /**
   * The angle field's own opener. Rotating a group is defined against the state
   * the gesture started from - the leaves and the pivot as they were - so this
   * bracket freezes that as well as opening the transaction, and every event of
   * the scrub is replayed against it. Its own prop rather than a label the panel
   * pattern-matches on: the freeze has to happen, and a history label is a string
   * for a menu item, not a contract.
   */
  onRotateScrubStart: () => void;
  onScrubEnd: () => void;
  /**
   * True when the selection holds nothing any of these five fields could move -
   * in practice only a group with every member locked, since a group itself is
   * always transformable through its leaves. One flag rather than one per field:
   * they all resolve to the same target now, and the panel decides it from that
   * target rather than from the selection, so a group sitting beside an ordinary
   * element leaves the fields live for both.
   */
  disabled?: boolean;
}

/**
 * Position, size, and transform.
 *
 * The one thing worth reading closely is the scrub bracketing. A `NumberField`
 * scrub emits an `onChange` per pointermove - dozens per second - and each of
 * those outside a transaction would be its own undo entry, so one drag of the X
 * field would cost the user 200 presses of Ctrl+Z to reverse. `onScrubStart`
 * opens a transaction and `onScrubEnd` commits it, which makes the whole
 * gesture one entry, exactly as dragging the shape on canvas already is. A
 * typed-and-committed value fires `onChange` once and rides the store's
 * implicit transaction, so it is one entry for free.
 */
export function PositionSection({
  x,
  y,
  width,
  height,
  rotation,
  lockAspect,
  onLockAspectChange,
  onChange,
  onRotate,
  onScrubStart,
  onRotateScrubStart,
  onScrubEnd,
  disabled = false,
}: PositionSectionProps) {
  return (
    <>
      <PanelSection title="Position">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="X"
            value={fieldValue(x)}
            precision={1}
            disabled={disabled}
            onChange={(next) => {
              onChange({ x: next }, 'Move');
            }}
            onScrubStart={() => {
              onScrubStart('Move');
            }}
            onScrubEnd={onScrubEnd}
          />
          <NumberField
            label="Y"
            value={fieldValue(y)}
            precision={1}
            disabled={disabled}
            onChange={(next) => {
              onChange({ y: next }, 'Move');
            }}
            onScrubStart={() => {
              onScrubStart('Move');
            }}
            onScrubEnd={onScrubEnd}
          />
        </div>
      </PanelSection>

      <PanelSection title="Size">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="W"
            value={fieldValue(width)}
            min={1}
            precision={1}
            disabled={disabled}
            onChange={(next) => {
              onChange({ width: next }, 'Resize');
            }}
            onScrubStart={() => {
              onScrubStart('Resize');
            }}
            onScrubEnd={onScrubEnd}
          />
          <NumberField
            label="H"
            value={fieldValue(height)}
            min={1}
            precision={1}
            disabled={disabled}
            onChange={(next) => {
              onChange({ height: next }, 'Resize');
            }}
            onScrubStart={() => {
              onScrubStart('Resize');
            }}
            onScrubEnd={onScrubEnd}
          />
        </div>

        {/* A switch on its own ruled-off row, not an icon button inside the W/H
            row. Everything in that row is a property of the selected element and
            this is not: it is a tool mode - "Shift held permanently" - that the
            canvas resize handles read too, so it stays on when the selection
            changes. Sitting in the row made it read as the fourth field, which
            is how it came to be reported as a bug. It stays inside SIZE because
            coupling W to H is the visible half of what it does; the rule and the
            description are what say it is not one of them. The `Link`/`Link2Off`
            pair goes with it - a switch's thumb position already carries on/off
            without relying on colour, and a switch is what this app already uses
            for a setting that takes effect immediately. */}
        <Toggle
          label="Lock aspect ratio"
          description="Editor-wide, not per element - stays on until you turn it off."
          tone="field"
          checked={lockAspect}
          onChange={onLockAspectChange}
          disabled={disabled}
          size="sm"
          className="border-edge border-t pt-2.5"
        />
      </PanelSection>

      <PanelSection title="Transform">
        {/* Full width, not a half-width cell: at 264px of panel the word
            "ANGLE" plus a three-digit value plus the degree suffix do not fit
            in half a row, and the field would truncate its own label. Fields
            are paired only when their labels are single letters. */}
        <div>
          <NumberField
            label="Angle"
            // Stored in radians, shown in degrees: nobody types 0.7853981634.
            value={rotation.kind === 'uniform' ? rotation.value * DEGREES_PER_RADIAN : null}
            unit="°"
            precision={1}
            disabled={disabled}
            onChange={(next) => {
              onRotate(next / DEGREES_PER_RADIAN);
            }}
            onScrubStart={onRotateScrubStart}
            onScrubEnd={onScrubEnd}
          />
        </div>
      </PanelSection>
    </>
  );
}
