import { describe, expect, it } from 'vitest';

import { MIN_ELEMENT_SIZE, PASTE_OFFSET } from '@/constants';
import {
  cloneElements,
  createArrow,
  createEllipse,
  createFreehand,
  createGroup,
  createImage,
  createLine,
  createRectangle,
  createText,
  nextElementName,
} from '@/features/elements/factory';
import type { CanvasElement } from '@/types';
import { worldPoint, worldRect } from '@/utils/coords';

const BOX = worldRect(10, 20, 100, 50);

describe('createRectangle', () => {
  it('produces a complete, unrotated, visible element', () => {
    const rect = createRectangle(BOX);
    expect(rect).toMatchObject({
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      rotation: 0,
      locked: false,
      visible: true,
    });
    expect(rect.id).not.toHaveLength(0);
  });

  it('normalizes a rect dragged up and to the left', () => {
    const rect = createRectangle(worldRect(100, 100, -40, -30));
    expect(rect).toMatchObject({ x: 60, y: 70, width: 40, height: 30 });
  });

  it('never produces a zero-area, unclickable shape', () => {
    const rect = createRectangle(worldRect(0, 0, 0, 0));
    expect(rect.width).toBe(MIN_ELEMENT_SIZE);
    expect(rect.height).toBe(MIN_ELEMENT_SIZE);
  });

  it('takes paint properties from the style override', () => {
    const rect = createRectangle(BOX, { style: { fill: '#ff0000', cornerRadius: 12 } });
    expect(rect.fill).toBe('#ff0000');
    expect(rect.cornerRadius).toBe(12);
  });

  it('mints a fresh id every call', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createRectangle(BOX).id));
    expect(ids.size).toBe(200);
  });
});

describe('auto-generated names', () => {
  it('starts at 1 in an empty document', () => {
    expect(createRectangle(BOX).name).toBe('Rectangle 1');
  });

  it('counts per type, not globally', () => {
    const existing: CanvasElement[] = [createRectangle(BOX), createEllipse(BOX)];
    expect(createEllipse(BOX, { existing }).name).toBe('Ellipse 2');
    expect(createRectangle(BOX, { existing }).name).toBe('Rectangle 2');
  });

  it('takes the highest suffix, so deleting a middle element cannot cause a duplicate', () => {
    const one = createRectangle(BOX, { name: 'Rectangle 1' });
    const two = createRectangle(BOX, { name: 'Rectangle 2' });
    const three = createRectangle(BOX, { name: 'Rectangle 3' });

    // Delete "Rectangle 2" and add a new one: the next name must not be 2 or 3.
    const remaining = [one, three];
    const added = createRectangle(BOX, { existing: remaining });
    expect(added.name).toBe('Rectangle 4');
    expect([one, two, three, added].map((e) => e.name)).toHaveLength(4);
  });

  it('ignores renamed elements that no longer match the pattern', () => {
    const existing = [createRectangle(BOX, { name: 'Hero card' })];
    expect(nextElementName('rectangle', existing)).toBe('Rectangle 1');
  });

  it('accepts an explicit name', () => {
    expect(createRectangle(BOX, { name: 'Header' }).name).toBe('Header');
  });
});

describe('createLine / createArrow', () => {
  it('stores endpoints normalized inside the bounding box', () => {
    const line = createLine(worldPoint(0, 0), worldPoint(100, 50));
    expect(line).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
    expect(line.start).toEqual({ x: 0, y: 0 });
    expect(line.end).toEqual({ x: 1, y: 1 });
  });

  it('keeps drag direction, which a normalized rect would have thrown away', () => {
    const line = createLine(worldPoint(100, 0), worldPoint(0, 50));
    expect(line).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
    expect(line.start).toEqual({ x: 1, y: 0 });
    expect(line.end).toEqual({ x: 0, y: 1 });
  });

  it('widens and re-centres the degenerate axis of a perfectly horizontal line', () => {
    const line = createLine(worldPoint(0, 40), worldPoint(80, 40));
    expect(line.height).toBe(MIN_ELEMENT_SIZE);
    expect(line.y).toBeCloseTo(40 - MIN_ELEMENT_SIZE / 2);
    expect(line.start.y).toBeCloseTo(0.5);
    expect(line.end.y).toBeCloseTo(0.5);
  });

  it('gives arrows their arrowhead styles', () => {
    const arrow = createArrow(worldPoint(0, 0), worldPoint(10, 10), {
      style: { arrowheadStart: 'line', arrowheadEnd: 'triangle' },
    });
    expect(arrow).toMatchObject({
      type: 'arrow',
      arrowheadStart: 'line',
      arrowheadEnd: 'triangle',
    });
  });
});

describe('createFreehand', () => {
  it('normalizes every point into the bounding box', () => {
    const stroke = createFreehand([worldPoint(10, 10), worldPoint(30, 20), worldPoint(50, 60)]);
    expect(stroke).toMatchObject({ x: 10, y: 10, width: 40, height: 50 });
    expect(stroke.points[0]).toEqual({ x: 0, y: 0 });
    expect(stroke.points[2]).toEqual({ x: 1, y: 1 });
    for (const point of stroke.points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
    }
  });

  it('names freehand strokes "Path"', () => {
    expect(createFreehand([worldPoint(0, 0)]).name).toBe('Path 1');
  });
});

describe('createText', () => {
  it('gives a click-placed box one line of height and leaves autoHeight on', () => {
    const text = createText(worldRect(0, 0, 200, 0), { style: { fontSize: 20, lineHeight: 1.5 } });
    expect(text.height).toBeCloseTo(30);
    expect(text.autoHeight).toBe(true);
    expect(text.text).toBe('');
  });
});

describe('createImage', () => {
  it('references a blob key rather than pixel data', () => {
    const image = createImage(BOX, {
      imageKey: 'sha-abc',
      naturalWidth: 800,
      naturalHeight: 400,
      alt: 'Logo',
    });
    expect(image).toMatchObject({ imageKey: 'sha-abc', naturalWidth: 800, alt: 'Logo' });
    expect(image).not.toHaveProperty('data');
  });
});

describe('cloneElements', () => {
  const source: CanvasElement[] = [
    createRectangle(worldRect(0, 0, 10, 10), { name: 'Rectangle 1' }),
    createEllipse(worldRect(50, 50, 10, 10), { name: 'Ellipse 1' }),
  ];

  it('offsets the copies so they do not hide the originals', () => {
    const { elements } = cloneElements(source);
    expect(elements[0]).toMatchObject({ x: PASTE_OFFSET, y: PASTE_OFFSET });
    expect(elements[1]).toMatchObject({ x: 50 + PASTE_OFFSET, y: 50 + PASTE_OFFSET });
  });

  it('never reuses an id, across the source set or across repeated clones', () => {
    const seen = new Set(source.map((element) => element.id));
    for (let round = 0; round < 50; round++) {
      const { elements } = cloneElements(source);
      for (const element of elements) {
        expect(seen.has(element.id)).toBe(false);
        seen.add(element.id);
      }
    }
    expect(seen.size).toBe(source.length + 50 * source.length);
  });

  it('returns a mapping that agrees with the cloned elements', () => {
    const { elements, idMap } = cloneElements(source);
    expect(idMap.size).toBe(source.length);
    source.forEach((original, index) => {
      expect(idMap.get(original.id)).toBe(elements[index]?.id);
    });
  });

  it('accepts an explicit offset for duplicate-in-place', () => {
    const { elements } = cloneElements(source, { x: 0, y: 0 });
    expect(elements[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('copies everything else verbatim, including the name', () => {
    const { elements } = cloneElements(source);
    expect(elements[0]?.name).toBe('Rectangle 1');
    expect(elements[0]?.type).toBe('rectangle');
  });

  it('remaps a cloned group onto the cloned members', () => {
    const member = createRectangle(worldRect(0, 0, 10, 10));
    const group = createGroup([member.id]);
    const { elements, idMap } = cloneElements([group, member]);

    // Without the remap the copy would point at the original's member, which is
    // an element that already has a parent.
    expect(elements[0]).toMatchObject({ childIds: [idMap.get(member.id)] });
    expect(elements[0]?.id).not.toBe(group.id);
  });

  it('drops a childId the clone set does not contain', () => {
    // Copying a group without its members - or pasting one from another tab,
    // where the ids belong to a document this one has never seen. Carrying the
    // id across would make the copy claim someone else's element.
    const group = createGroup(['not-in-this-set']);
    const { elements } = cloneElements([group]);

    expect(elements[0]).toMatchObject({ childIds: [] });
  });
});
