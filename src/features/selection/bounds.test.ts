import { describe, expect, it } from 'vitest';
import type { CanvasElement, RectangleElement } from '@/types';
import { contentBounds, elementBounds, elementRect, selectionBounds, selectionRect } from './bounds';

function rect(id: string, overrides: Partial<RectangleElement> = {}): RectangleElement {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    strokeStyle: 'solid',
    cornerRadius: 0,
    ...overrides,
  };
}

describe('elementRect / elementBounds', () => {
  it('elementRect ignores rotation', () => {
    const tilted = rect('a', { rotation: Math.PI / 4 });
    expect(elementRect(tilted)).toEqual({ x: 0, y: 0, width: 100, height: 40 });
  });

  it('elementBounds equals elementRect when unrotated', () => {
    const flat = rect('a', { x: 5, y: 6 });
    expect(elementBounds(flat)).toEqual(elementRect(flat));
  });

  it('elementBounds grows to the rotated extent', () => {
    // 200x20 rotated a quarter turn about its centre (100, 10) occupies
    // x ∈ [90, 110], y ∈ [-90, 110].
    const bar = rect('bar', { width: 200, height: 20, rotation: Math.PI / 2 });
    const bounds = elementBounds(bar);
    expect(bounds.x).toBeCloseTo(90, 9);
    expect(bounds.y).toBeCloseTo(-90, 9);
    expect(bounds.width).toBeCloseTo(20, 9);
    expect(bounds.height).toBeCloseTo(200, 9);
  });
});

describe('selectionBounds', () => {
  it('reports "none" for an empty selection rather than a zero rect', () => {
    const bounds = selectionBounds([]);
    expect(bounds.kind).toBe('none');
    expect(selectionRect(bounds)).toBeNull();
  });

  it('a single element keeps its own unrotated rect plus its angle', () => {
    // This is the distinction the overlay depends on: a tilted frame that hugs
    // the shape, not an upright box that touches it nowhere.
    const tilted = rect('solo', { x: 10, y: 20, rotation: Math.PI / 3 });
    const bounds = selectionBounds([tilted]);

    expect(bounds.kind).toBe('single');
    if (bounds.kind !== 'single') return;
    expect(bounds.id).toBe('solo');
    expect(bounds.rect).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(bounds.rotation).toBeCloseTo(Math.PI / 3, 12);
  });

  it('a single element does NOT report its rotated AABB as the rect', () => {
    const bar = rect('bar', { width: 200, height: 20, rotation: Math.PI / 2 });
    const bounds = selectionBounds([bar]);
    if (bounds.kind !== 'single') throw new Error('expected single');
    expect(bounds.rect.width).toBe(200);
    expect(bounds.rect).not.toEqual(elementBounds(bar));
  });

  it('multiple elements union their rotated AABBs and are always upright', () => {
    const a = rect('a', { x: 0, y: 0, width: 100, height: 40 });
    const b = rect('b', { x: 200, y: 100, width: 50, height: 50 });
    const bounds = selectionBounds([a, b]);

    expect(bounds.kind).toBe('multiple');
    if (bounds.kind !== 'multiple') return;
    expect(bounds.rotation).toBe(0);
    expect(bounds.count).toBe(2);
    expect(bounds.rect).toEqual({ x: 0, y: 0, width: 250, height: 150 });
  });

  it('a rotated member widens the group box beyond its unrotated rect', () => {
    const bar = rect('bar', { width: 200, height: 20, rotation: Math.PI / 2 });
    const other = rect('other', { x: 0, y: 0, width: 10, height: 10 });
    const bounds = selectionBounds([bar, other]);
    if (bounds.kind !== 'multiple') throw new Error('expected multiple');
    // The bar reaches y = -90 once rotated; ignoring rotation would start at 0.
    expect(bounds.rect.y).toBeCloseTo(-90, 9);
    expect(bounds.rect.height).toBeCloseTo(200, 9);
  });

  it('every branch exposes `rotation`, so consumers need no case analysis to read it', () => {
    const single = selectionBounds([rect('a', { rotation: 0.5 })]);
    const many = selectionBounds([rect('a'), rect('b')]);
    if (single.kind === 'none' || many.kind === 'none') throw new Error('unexpected');
    expect(single.rotation).toBeCloseTo(0.5, 12);
    expect(many.rotation).toBe(0);
  });
});

describe('contentBounds', () => {
  it('is null for an empty document', () => {
    expect(contentBounds([])).toBeNull();
  });

  it('ignores hidden elements, so zoom-to-fit does not frame invisible things', () => {
    const visible: CanvasElement = rect('v', { x: 0, y: 0, width: 10, height: 10 });
    const hidden: CanvasElement = rect('h', { x: 1000, y: 1000, visible: false });
    expect(contentBounds([visible, hidden])).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('ignores a group’s cached box, which spans its hidden members too', () => {
    // The store derives a group's box from *every* descendant, visible or not,
    // so the container's box and the union of what paints are different rects.
    // Counting the container would frame 1000 units of nothing.
    const shown: CanvasElement = rect('shown', { x: 0, y: 0, width: 10, height: 10 });
    const hidden: CanvasElement = rect('hidden', { x: 1000, y: 1000, visible: false });
    const container: CanvasElement = {
      id: 'g',
      type: 'group',
      name: 'Group 1',
      x: 0,
      y: 0,
      width: 1100,
      height: 1040,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      childIds: ['shown', 'hidden'],
    };
    expect(contentBounds([container, shown, hidden])).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  });
});
