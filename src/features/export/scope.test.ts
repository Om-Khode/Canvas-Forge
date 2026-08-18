/**
 * These go through the *real* store - `addElements`, `group`, `toggleVisible` -
 * rather than building an `ElementStore` literal, because the defect this file
 * exists to close was invisible to a suite of 900 tests for exactly that
 * reason: `order` holds root ids only after a group lands, and every test that
 * hand-builds a store puts the members in `order` itself and never notices.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { exportSubject } from './scope';
import { elementsToSvg } from './svg';
import { planPngExportFor } from './png';
import { createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store';
import type { ElementId } from '@/types';
import { worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();

function addRect(x: number, y: number, name: string): ElementId {
  const element = { ...createRectangle(worldRect(x, y, 10, 10)), name };
  state().addElement(element);
  return element.id;
}

beforeEach(() => {
  resetCanvasStore();
});

describe('a document whose content is entirely inside a group', () => {
  function grouped(): { groupId: ElementId; a: ElementId; b: ElementId } {
    const a = addRect(0, 0, 'A');
    const b = addRect(40, 40, 'B');
    const groupId = state().group([a, b]);
    if (groupId === null) throw new Error('grouping failed');
    return { groupId, a, b };
  }

  it('paints the members, which a walk over `order` cannot see', () => {
    const { groupId, a, b } = grouped();
    // The premise: the root order is the group and nothing else.
    expect(state().elements.order).toEqual([groupId]);

    const subject = exportSubject(state().elements, null);
    expect(subject.paint.map((element) => element.id)).toContain(a);
    expect(subject.paint.map((element) => element.id)).toContain(b);
  });

  it('gives the PNG planner a real box rather than nothing to draw', () => {
    grouped();
    const plan = planPngExportFor(exportSubject(state().elements, null).paint, { scale: 1 });
    if (plan === null) throw new Error('expected a plan');
    // The two 10×10 rects span 50×50 before the exporter's 24-unit padding.
    expect(plan.worldBounds.width).toBe(50 + 48);
    expect(plan.worldBounds.height).toBe(50 + 48);
  });

  it('gives the SVG serializer the whole tree, so the members reach the file', () => {
    grouped();
    const svg = elementsToSvg(exportSubject(state().elements, null).pool, { images: {} });
    expect(svg).toContain('<title>A</title>');
    expect(svg).toContain('<title>B</title>');
    // Nested, not flattened: the group is still a container in the output.
    expect(svg.match(/<rect /g)).toHaveLength(2);
  });
});

describe('visibility', () => {
  it('does not re-admit a member of a hidden group', () => {
    const a = addRect(0, 0, 'A');
    const b = addRect(40, 40, 'B');
    const groupId = state().group([a, b]);
    if (groupId === null) throw new Error('grouping failed');
    state().toggleVisible(groupId);

    const subject = exportSubject(state().elements, null);
    // `visible` on the member still says true; the ancestor is what decides.
    expect(state().elements.byId[a]?.visible).toBe(true);
    expect(subject.paint).toEqual([]);
    // The pool is deliberately unfiltered - the serializer applies `visible`
    // itself, and it must see the group to know the member is under it.
    expect(subject.pool.map((element) => element.id)).toEqual([groupId, a, b]);
    expect(elementsToSvg(subject.pool, { images: {} })).not.toContain('<rect ');
  });

  it('drops a hidden member from the paint list but keeps its visible sibling', () => {
    const a = addRect(0, 0, 'A');
    const b = addRect(400, 400, 'B');
    const groupId = state().group([a, b]);
    if (groupId === null) throw new Error('grouping failed');
    state().toggleVisible(b);

    const subject = exportSubject(state().elements, null);
    // The group stays - it is the container the overlay and the serializer
    // still need - but the hidden member is gone.
    expect(subject.paint.map((element) => element.id)).toEqual([groupId, a]);
  });

  it('frames the SVG on what actually paints, not the group’s cached box (which still counts the hidden member)', () => {
    const a = addRect(0, 0, 'A');
    const b = addRect(400, 400, 'B');
    const groupId = state().group([a, b]);
    if (groupId === null) throw new Error('grouping failed');
    state().toggleVisible(b);

    // The premise: the group's own derived box still spans both members -
    // `deriveGroupRect` unions every descendant, hidden ones included.
    const group = state().elements.byId[groupId];
    expect(group?.width).toBeGreaterThan(400);

    const subject = exportSubject(state().elements, null);
    const svg = elementsToSvg(subject.pool, { images: {}, padding: 0 });
    // Framing on the group's own box would reserve a ~410×410 canvas for
    // content that no longer paints. The estimate shown before the click
    // (`contentBounds(subject.paint)`) agrees with this tighter box.
    expect(svg).toContain('viewBox="0 0 10 10"');
  });
});

describe('selection scope', () => {
  it('takes a selected group’s members with it', () => {
    const a = addRect(0, 0, 'A');
    const b = addRect(40, 40, 'B');
    const loose = addRect(500, 500, 'Loose');
    const groupId = state().group([a, b]);
    if (groupId === null) throw new Error('grouping failed');

    const subject = exportSubject(state().elements, new Set([groupId]));

    expect(subject.paint.map((element) => element.id)).toEqual([groupId, a, b]);
    expect(subject.pool.map((element) => element.id)).toEqual([groupId, a, b]);
    // The members are nested under the group, so only the group is a root -
    // writing a member at the root too would describe two different trees.
    expect(subject.rootIds).toEqual([groupId]);
    expect(subject.pool.map((element) => element.id)).not.toContain(loose);
  });

  it('ignores an id that is no longer in the document', () => {
    const a = addRect(0, 0, 'A');
    const subject = exportSubject(state().elements, new Set(['gone', a]));
    expect(subject.pool.map((element) => element.id)).toEqual([a]);
    expect(subject.rootIds).toEqual([a]);
  });

  it('keeps a selected descendant’s ancestor group, so PNG and SVG/JSON agree on its opacity', () => {
    const a = addRect(0, 0, 'A');
    const b = addRect(40, 40, 'B');
    const groupId = state().group([a, b]);
    if (groupId === null) throw new Error('grouping failed');
    state().updateElement(groupId, { opacity: 0.5 });

    // Only `a` is selected - not the group, not `b`.
    const subject = exportSubject(state().elements, new Set([a]));

    // The group is why `a` renders at half opacity; `paint` already folds
    // that in (this is what PNG reads), so this is the pre-existing, correct
    // half.
    const painted = subject.paint.find((element) => element.id === a);
    expect(painted?.opacity).toBe(0.5);

    // SVG/JSON rebuild the tree from `pool` and apply a group's opacity
    // themselves, so the group has to travel with its selected member or the
    // file silently loses it - the divergence this test pins.
    expect(subject.pool.map((element) => element.id)).toEqual([groupId, a]);
    expect(subject.rootIds).toEqual([groupId]);
    // `b`, never selected, must not tag along just because its parent did.
    expect(subject.pool.map((element) => element.id)).not.toContain(b);

    const svg = elementsToSvg(subject.pool, { images: {} });
    expect(svg).toContain('opacity="0.5"');
  });
});
