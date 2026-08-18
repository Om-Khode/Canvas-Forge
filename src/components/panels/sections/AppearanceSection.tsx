import { ColorField, NumberField, PanelSection, Select } from '@/components/common';
import type { SelectOption } from '@/components/common';
import { STROKE_WIDTHS } from '@/constants';
import type { ElementPatch } from '@/features/elements/operations';
import { fieldValue, type PropertyValue } from '@/features/properties/mixed';
import type { StrokeStyle } from '@/types';

export interface AppearanceSectionProps {
  fill: PropertyValue<string | null>;
  stroke: PropertyValue<string | null>;
  strokeWidth: PropertyValue<number>;
  strokeStyle: PropertyValue<StrokeStyle>;
  opacity: PropertyValue<number>;
  cornerRadius: PropertyValue<number>;
  onChange: (patch: ElementPatch, label: string) => void;
  onScrubStart: (label: string) => void;
  onScrubEnd: () => void;
}

/**
 * A `<select>` must have its current value among its options, and "several
 * different values" is not one of them - so mixed states get a real, disabled
 * option rather than an empty control that silently displays the first entry as
 * though the whole selection agreed on it.
 */
const MIXED_OPTION: SelectOption<string> = { value: '', label: 'Mixed', disabled: true };

function withMixed(
  options: readonly SelectOption<string>[],
  property: PropertyValue<unknown>
): readonly SelectOption<string>[] {
  return property.kind === 'uniform' ? options : [MIXED_OPTION, ...options];
}

const STROKE_WIDTH_OPTIONS: readonly SelectOption<string>[] = STROKE_WIDTHS.map((width) => ({
  value: String(width),
  label: `${width} px`,
}));

const STROKE_STYLE_OPTIONS: readonly SelectOption<string>[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

/**
 * Fill, stroke, opacity, corner radius - whichever of them the selection
 * actually has.
 *
 * Each control is gated on `kind !== 'absent'`, not on a type check against the
 * selection: three lines have no fill, so no fill swatch is rendered, and a
 * rectangle beside a line still shows one because the property exists somewhere
 * in the selection. Writing it back only touches the members that carry it.
 *
 * `ColorField` has no mixed state of its own - its `null` means "no fill",
 * which is a different fact - so a disagreement is carried in the label
 * instead, where it also lands in the control's accessible name.
 */
export function AppearanceSection({
  fill,
  stroke,
  strokeWidth,
  strokeStyle,
  opacity,
  cornerRadius,
  onChange,
  onScrubStart,
  onScrubEnd,
}: AppearanceSectionProps) {
  return (
    <PanelSection title="Appearance">
      {fill.kind !== 'absent' && (
        <ColorField
          label={fill.kind === 'mixed' ? 'Fill (mixed)' : 'Fill'}
          value={fieldValue(fill)}
          allowTransparent
          onChange={(next) => {
            onChange({ fill: next }, 'Set fill');
          }}
        />
      )}

      {stroke.kind !== 'absent' && (
        <ColorField
          label={stroke.kind === 'mixed' ? 'Stroke (mixed)' : 'Stroke'}
          value={fieldValue(stroke)}
          allowTransparent
          onChange={(next) => {
            onChange({ stroke: next }, 'Set stroke');
          }}
        />
      )}

      {strokeWidth.kind !== 'absent' && (
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="Width"
            fieldSize="sm"
            value={strokeWidth.kind === 'uniform' ? String(strokeWidth.value) : ''}
            options={withMixed(STROKE_WIDTH_OPTIONS, strokeWidth)}
            onChange={(next) => {
              onChange({ strokeWidth: Number(next) }, 'Set stroke width');
            }}
          />
          <Select
            label="Style"
            fieldSize="sm"
            value={strokeStyle.kind === 'uniform' ? strokeStyle.value : ''}
            options={withMixed(STROKE_STYLE_OPTIONS, strokeStyle)}
            onChange={(next) => {
              onChange({ strokeStyle: next as StrokeStyle }, 'Set stroke style');
            }}
          />
        </div>
      )}

      {/* Stacked rather than paired: "OPACITY" and "RADIUS" are words, and a
          word label plus a three-digit value plus a unit does not fit in half
          of a 264px panel. Vertical space is the cheap axis here. */}
      <div className="flex flex-col gap-2">
        <NumberField
          label="Opacity"
          // Stored 0..1, edited as a percentage - the unit users think in.
          value={opacity.kind === 'uniform' ? Math.round(opacity.value * 100) : null}
          unit="%"
          min={0}
          max={100}
          precision={0}
          onChange={(next) => {
            onChange({ opacity: next / 100 }, 'Set opacity');
          }}
          onScrubStart={() => {
            onScrubStart('Set opacity');
          }}
          onScrubEnd={onScrubEnd}
        />

        {cornerRadius.kind !== 'absent' && (
          <NumberField
            label="Radius"
            value={fieldValue(cornerRadius)}
            min={0}
            precision={0}
            onChange={(next) => {
              onChange({ cornerRadius: next }, 'Set corner radius');
            }}
            onScrubStart={() => {
              onScrubStart('Set corner radius');
            }}
            onScrubEnd={onScrubEnd}
          />
        )}
      </div>
    </PanelSection>
  );
}
