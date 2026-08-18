import { describe, expect, it } from 'vitest';

import {
  createEllipse,
  createLine,
  createRectangle,
  createText,
} from '@/features/elements/factory';
import {
  ABSENT,
  MIXED,
  applicablePatches,
  fieldValue,
  hasProperty,
  readProperty,
  supportsProperty,
  uniform,
} from '@/features/properties/mixed';
import type { CanvasElement } from '@/types';
import { worldPoint, worldRect } from '@/utils/coords';

const rect = (style?: Parameters<typeof createRectangle>[1]): CanvasElement =>
  createRectangle(worldRect(0, 0, 100, 50), style);

const ellipse = (style?: Parameters<typeof createEllipse>[1]): CanvasElement =>
  createEllipse(worldRect(0, 0, 100, 50), style);

const line = (): CanvasElement => createLine(worldPoint(0, 0), worldPoint(10, 10));

const text = (): CanvasElement => createText(worldRect(0, 0, 100, 40));

describe('readProperty', () => {
  it('reports absent for an empty selection', () => {
    expect(readProperty([], 'fill')).toEqual(ABSENT);
  });

  it('reports the value when one element carries the property', () => {
    expect(readProperty([rect({ style: { fill: '#ff0000' } })], 'fill')).toEqual({
      kind: 'uniform',
      value: '#ff0000',
    });
  });

  it('reports uniform when every element agrees', () => {
    const elements = [
      rect({ style: { fill: '#123456' } }),
      ellipse({ style: { fill: '#123456' } }),
    ];
    expect(readProperty(elements, 'fill')).toEqual({ kind: 'uniform', value: '#123456' });
  });

  it('reports mixed when they disagree', () => {
    const elements = [
      rect({ style: { fill: '#111111' } }),
      ellipse({ style: { fill: '#222222' } }),
    ];
    expect(readProperty(elements, 'fill')).toEqual(MIXED);
  });

  it('treats "no fill" as a real value, not a missing one', () => {
    // Both hollow: they agree, and the agreed value is null.
    expect(
      readProperty([rect({ style: { fill: null } }), ellipse({ style: { fill: null } })], 'fill')
    ).toEqual({
      kind: 'uniform',
      value: null,
    });

    // Hollow beside filled: a disagreement about fill, not an absence of fill.
    // This is the case that must not collapse into `absent`.
    expect(
      readProperty([rect({ style: { fill: null } }), ellipse({ style: { fill: '#fff' } })], 'fill')
    ).toEqual(MIXED);
  });

  it('reports absent - not mixed - when no element has the property', () => {
    // Three lines have no fill at all. Rendering a fill control here would let
    // the user write `fill` onto a LineElement.
    expect(readProperty([line(), line(), line()], 'fill')).toEqual(ABSENT);
    expect(readProperty([line()], 'cornerRadius')).toEqual(ABSENT);
    expect(readProperty([rect(), ellipse()], 'cornerRadius')).toEqual({
      kind: 'uniform',
      value: 4,
    });
  });

  it('ignores elements that lack the property rather than counting them as a disagreement', () => {
    // One fill in the selection, so there is exactly one answer to show.
    const elements = [rect({ style: { fill: '#abcdef' } }), line()];
    expect(readProperty(elements, 'fill')).toEqual({ kind: 'uniform', value: '#abcdef' });
  });

  it('reads properties every element shares', () => {
    const elements = [rect(), line(), text()];
    expect(readProperty(elements, 'opacity')).toEqual({ kind: 'uniform', value: 1 });
    expect(readProperty(elements, 'rotation')).toEqual({ kind: 'uniform', value: 0 });
    expect(readProperty([rect(), createRectangle(worldRect(20, 0, 100, 50))], 'x')).toEqual(MIXED);
  });

  it('reads text-only properties from a mixed-type selection', () => {
    expect(readProperty([rect(), text()], 'fontSize')).toEqual({ kind: 'uniform', value: 20 });
    expect(readProperty([rect(), line()], 'fontSize')).toEqual(ABSENT);
  });

  it('short-circuits on the first disagreement', () => {
    const elements = [
      rect({ style: { strokeWidth: 1 } }),
      rect({ style: { strokeWidth: 2 } }),
      rect({ style: { strokeWidth: 3 } }),
    ];
    expect(readProperty(elements, 'strokeWidth')).toEqual(MIXED);
  });
});

describe('hasProperty / supportsProperty', () => {
  it('answers per element', () => {
    expect(hasProperty(rect(), 'cornerRadius')).toBe(true);
    expect(hasProperty(ellipse(), 'cornerRadius')).toBe(false);
    expect(hasProperty(line(), 'fill')).toBe(false);
    expect(hasProperty(text(), 'color')).toBe(true);
  });

  it('answers per selection', () => {
    expect(supportsProperty([line(), rect()], 'fill')).toBe(true);
    expect(supportsProperty([line(), text()], 'fill')).toBe(false);
    expect(supportsProperty([], 'fill')).toBe(false);
  });
});

describe('fieldValue', () => {
  it('maps uniform to the value and everything else to null', () => {
    expect(fieldValue(uniform(12))).toBe(12);
    expect(fieldValue(MIXED)).toBeNull();
    expect(fieldValue(ABSENT)).toBeNull();
    // A uniform `null` is indistinguishable from mixed at the field level; that
    // is exactly what the primitives' `value: T | null` contract already says,
    // and it is why the *section* decides what to render from `kind`.
    expect(fieldValue(uniform(null))).toBeNull();
  });
});

describe('applicablePatches', () => {
  it('patches only the elements that carry the property', () => {
    const filled = rect();
    const stroked = line();

    const patches = applicablePatches([filled, stroked], { fill: '#ff0000' });

    expect(patches).toEqual({ [filled.id]: { fill: '#ff0000' } });
    // The line is absent from the map entirely, so the store never mints a new
    // object for it - and never writes a property its variant cannot hold.
    expect(stroked.id in patches).toBe(false);
  });

  it('splits a multi-key patch per element', () => {
    const box = rect();
    const stroked = line();

    const patches = applicablePatches([box, stroked], { stroke: '#000', cornerRadius: 8 });

    expect(patches[box.id]).toEqual({ stroke: '#000', cornerRadius: 8 });
    expect(patches[stroked.id]).toEqual({ stroke: '#000' });
  });

  it('returns an empty map when nothing applies', () => {
    expect(applicablePatches([line(), line()], { fill: '#fff' })).toEqual({});
    expect(applicablePatches([], { fill: '#fff' })).toEqual({});
  });

  it('passes through properties every element shares', () => {
    const a = rect();
    const b = line();
    const c = text();

    expect(applicablePatches([a, b, c], { opacity: 0.5 })).toEqual({
      [a.id]: { opacity: 0.5 },
      [b.id]: { opacity: 0.5 },
      [c.id]: { opacity: 0.5 },
    });
  });

  it('preserves a null value rather than dropping the key', () => {
    const box = rect();
    expect(applicablePatches([box], { fill: null })).toEqual({ [box.id]: { fill: null } });
  });
});
