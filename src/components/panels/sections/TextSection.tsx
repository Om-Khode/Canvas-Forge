import { Italic, TextAlignCenter, TextAlignEnd, TextAlignStart } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ColorField, IconButton, NumberField, PanelSection, Select } from '@/components/common';
import type { SelectOption } from '@/components/common';
import { FONT_FAMILIES, FONT_SIZES, FONT_WEIGHTS } from '@/constants';
import type { ElementPatch } from '@/features/elements/operations';
import { fieldValue, type PropertyValue } from '@/features/properties/mixed';
import type { FontWeight, TextAlign } from '@/types';

export interface TextSectionProps {
  fontFamily: PropertyValue<string>;
  fontSize: PropertyValue<number>;
  fontWeight: PropertyValue<FontWeight>;
  italic: PropertyValue<boolean>;
  textAlign: PropertyValue<TextAlign>;
  lineHeight: PropertyValue<number>;
  color: PropertyValue<string>;
  onChange: (patch: ElementPatch, label: string) => void;
  onScrubStart: (label: string) => void;
  onScrubEnd: () => void;
}

const MIXED_OPTION: SelectOption<string> = { value: '', label: 'Mixed', disabled: true };

function withMixed(
  options: readonly SelectOption<string>[],
  property: PropertyValue<unknown>
): readonly SelectOption<string>[] {
  return property.kind === 'uniform' ? options : [MIXED_OPTION, ...options];
}

const FAMILY_OPTIONS: readonly SelectOption<string>[] = FONT_FAMILIES.map((family) => ({
  value: family.value,
  label: family.label,
}));

const SIZE_OPTIONS: readonly SelectOption<string>[] = FONT_SIZES.map((size) => ({
  value: String(size),
  label: String(size),
}));

const WEIGHT_LABELS: Readonly<Record<FontWeight, string>> = {
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
};

const WEIGHT_OPTIONS: readonly SelectOption<string>[] = FONT_WEIGHTS.map((weight) => ({
  value: String(weight),
  label: WEIGHT_LABELS[weight],
}));

const ALIGNMENTS: readonly { value: TextAlign; label: string; icon: LucideIcon }[] = [
  { value: 'left', label: 'Align text left', icon: TextAlignStart },
  { value: 'center', label: 'Align text centre', icon: TextAlignCenter },
  { value: 'right', label: 'Align text right', icon: TextAlignEnd },
];

/**
 * Typography controls. Rendered only when the selection contains text.
 *
 * Alignment and italic are individual toggle buttons in a labelled group rather
 * than a `SegmentedControl`, because a segmented control is a radiogroup: it
 * has a roving tabindex anchored to the selected option, and a *mixed*
 * selection has no selected option - every segment would end up `tabIndex={-1}`
 * and the control would drop out of the tab order exactly when the user most
 * needs to reach it. Separate buttons with `aria-pressed` are always focusable
 * and say "none of these is currently true for the whole selection" honestly.
 */
export function TextSection({
  fontFamily,
  fontSize,
  fontWeight,
  italic,
  textAlign,
  lineHeight,
  color,
  onChange,
  onScrubStart,
  onScrubEnd,
}: TextSectionProps) {
  return (
    <PanelSection title="Text">
      <Select
        label="Font"
        fieldSize="sm"
        value={fontFamily.kind === 'uniform' ? fontFamily.value : ''}
        options={withMixed(FAMILY_OPTIONS, fontFamily)}
        onChange={(next) => {
          onChange({ fontFamily: next }, 'Set font');
        }}
      />

      <div className="grid grid-cols-2 gap-2">
        <Select
          label="Size"
          fieldSize="sm"
          value={fontSize.kind === 'uniform' ? String(fontSize.value) : ''}
          options={withMixed(SIZE_OPTIONS, fontSize)}
          onChange={(next) => {
            onChange({ fontSize: Number(next) }, 'Set font size');
          }}
        />
        <Select
          label="Weight"
          fieldSize="sm"
          value={fontWeight.kind === 'uniform' ? String(fontWeight.value) : ''}
          options={withMixed(WEIGHT_OPTIONS, fontWeight)}
          onChange={(next) => {
            // The options are built from FONT_WEIGHTS, so the parse can only
            // produce a member of the union.
            onChange({ fontWeight: Number(next) as FontWeight }, 'Set font weight');
          }}
        />
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Text style">
        {ALIGNMENTS.map((alignment) => (
          <IconButton
            key={alignment.value}
            icon={alignment.icon}
            label={alignment.label}
            size="sm"
            active={textAlign.kind === 'uniform' && textAlign.value === alignment.value}
            onClick={() => {
              onChange({ textAlign: alignment.value }, 'Set text alignment');
            }}
          />
        ))}
        <span aria-hidden="true" className="bg-edge mx-1 h-5 w-px" />
        <IconButton
          icon={Italic}
          label="Italic"
          size="sm"
          active={italic.kind === 'uniform' && italic.value}
          onClick={() => {
            // A mixed selection resolves to "make them all italic": the first
            // press should produce a visible, uniform result, not a no-op.
            onChange({ italic: !(italic.kind === 'uniform' && italic.value) }, 'Set italic');
          }}
        />
      </div>

      <NumberField
        label="Line height"
        value={fieldValue(lineHeight)}
        min={0.5}
        max={4}
        step={0.05}
        precision={2}
        onChange={(next) => {
          onChange({ lineHeight: next }, 'Set line height');
        }}
        onScrubStart={() => {
          onScrubStart('Set line height');
        }}
        onScrubEnd={onScrubEnd}
      />

      <ColorField
        label={color.kind === 'mixed' ? 'Colour (mixed)' : 'Colour'}
        value={fieldValue(color)}
        onChange={(next) => {
          // `allowTransparent` is off, so the palette offers no null - but the
          // primitive's type still permits one and text with no colour is not a
          // state the model has.
          if (next !== null) onChange({ color: next }, 'Set text colour');
        }}
      />
    </PanelSection>
  );
}
