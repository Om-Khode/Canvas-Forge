import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@/constants/storage';
import { createRectangle } from '@/features/elements/factory';
import { createGroup } from '@/features/elements/group';
import { elementsInPaintOrder, parentOf } from '@/features/elements/tree';
import type { CanvasElement, Project, SerializedProject } from '@/types';
import { worldRect } from '@/utils/coords';
import { deserializeProject, fromSerialized, serializeProject } from './serialize';

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/** One of every variant, with non-default values in every field. */
const ELEMENTS: readonly CanvasElement[] = [
  {
    id: 'rect-1',
    type: 'rectangle',
    name: 'Card',
    x: -12.5,
    y: 40,
    width: 200,
    height: 120,
    rotation: Math.PI / 7,
    opacity: 0.42,
    locked: true,
    visible: true,
    stroke: '#1c1c1f',
    strokeWidth: 4,
    strokeStyle: 'dashed',
    fill: '#e8e6e1',
    cornerRadius: 8,
  },
  {
    id: 'ellipse-1',
    type: 'ellipse',
    name: 'Dot',
    x: 0,
    y: 0,
    width: 30,
    height: 30,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: false,
    stroke: null,
    strokeWidth: 2,
    strokeStyle: 'solid',
    fill: '#3b6fa8',
  },
  {
    id: 'line-1',
    type: 'line',
    name: 'Rule',
    x: 10,
    y: 10,
    width: 100,
    height: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    stroke: '#6b7280',
    strokeWidth: 1,
    strokeStyle: 'dotted',
    start: { x: 0, y: 0.5 },
    end: { x: 1, y: 0.5 },
  },
  {
    id: 'arrow-1',
    type: 'arrow',
    name: 'Pointer',
    x: 0,
    y: 200,
    width: 80,
    height: 40,
    rotation: -0.7853981633974483,
    opacity: 0.9,
    locked: false,
    visible: true,
    stroke: '#c2603f',
    strokeWidth: 2,
    strokeStyle: 'solid',
    start: { x: 0, y: 1 },
    end: { x: 1, y: 0 },
    arrowheadStart: 'line',
    arrowheadEnd: 'triangle',
  },
  {
    id: 'text-1',
    type: 'text',
    name: 'Heading',
    x: 5,
    y: 5,
    width: 300,
    height: 60,
    rotation: 0.123456789012345,
    opacity: 1,
    locked: false,
    visible: true,
    text: 'Hello\nworld',
    fontFamily: "'Inter Variable', system-ui, sans-serif",
    fontSize: 32,
    fontWeight: 700,
    italic: true,
    textAlign: 'center',
    lineHeight: 1.35,
    color: '#1c1c1f',
    autoHeight: false,
  },
  {
    id: 'image-1',
    type: 'image',
    name: 'Photo',
    x: 400,
    y: 400,
    width: 160,
    height: 90,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    imageKey: 'sha256-abc',
    naturalWidth: 1600,
    naturalHeight: 900,
    alt: 'A photo',
  },
  {
    id: 'freehand-1',
    type: 'freehand',
    name: 'Scribble',
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    stroke: '#1c1c1f',
    strokeWidth: 2,
    strokeStyle: 'solid',
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.25 },
      { x: 1, y: 1 },
    ],
  },
];

function makeProject(): Project {
  const byId: Record<string, CanvasElement> = {};
  for (const element of ELEMENTS) byId[element.id] = element;
  return {
    id: 'project-1',
    name: 'Round trip',
    viewport: { panX: -120.25, panY: 33.5, zoom: 2.5 },
    elements: { byId, order: ELEMENTS.map((element) => element.id) },
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-02T12:00:00.000Z' },
  };
}

describe('serializeProject', () => {
  it('flattens the normalized store into paint order', () => {
    const serialized = serializeProject(makeProject());
    expect(serialized.elements.map((element) => element.id)).toEqual([
      'rect-1',
      'ellipse-1',
      'line-1',
      'arrow-1',
      'text-1',
      'image-1',
      'freehand-1',
    ]);
    expect(serialized.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('skips ids in the order array that have no element', () => {
    const project = makeProject();
    const broken: Project = {
      ...project,
      elements: { byId: project.elements.byId, order: [...project.elements.order, 'ghost'] },
    };
    expect(serializeProject(broken).elements).toHaveLength(ELEMENTS.length);
  });

  it('only inlines images that an element actually references', () => {
    const serialized = serializeProject(makeProject(), {
      'sha256-abc': PNG_DATA_URI,
      'sha256-orphan': PNG_DATA_URI,
    });
    expect(Object.keys(serialized.images)).toEqual(['sha256-abc']);
  });
});

describe('round trip', () => {
  it('survives JSON encoding with order, properties, and rotation intact', () => {
    const project = makeProject();
    const encoded = JSON.stringify(serializeProject(project, { 'sha256-abc': PNG_DATA_URI }));

    const result = deserializeProject(JSON.parse(encoded));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.warnings).toEqual([]);
    expect(result.value.project.elements.order).toEqual(project.elements.order);
    expect(result.value.project.elements.byId).toEqual(project.elements.byId);
    expect(result.value.project.viewport).toEqual(project.viewport);
    expect(result.value.project.metadata).toEqual(project.metadata);
    expect(result.value.images).toEqual({ 'sha256-abc': PNG_DATA_URI });
  });

  it('preserves rotation to full double precision', () => {
    const project = makeProject();
    const decoded = deserializeProject(JSON.parse(JSON.stringify(serializeProject(project))));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const text = decoded.value.project.elements.byId['text-1'];
    const rect = decoded.value.project.elements.byId['rect-1'];
    expect(text?.rotation).toBe(0.123456789012345);
    expect(rect?.rotation).toBe(Math.PI / 7);
  });

  it('rejects a document that is not an object', () => {
    const result = deserializeProject('not a project');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-an-object');
  });
});

describe('fromSerialized', () => {
  it('rebuilds byId and order without validating', () => {
    const serialized = serializeProject(makeProject());
    const project = fromSerialized(serialized);
    expect(project.elements.order).toHaveLength(ELEMENTS.length);
    expect(Object.keys(project.elements.byId)).toHaveLength(ELEMENTS.length);
  });
});

describe('nested serialization', () => {
  /** rect ⊂ inner ⊂ outer, with `outer` the only root. */
  function makeNested(): Project {
    const rect = createRectangle(worldRect(0, 0, 10, 10));
    const inner = createGroup([rect.id], { name: 'Inner' });
    const outer = createGroup([inner.id], { name: 'Outer' });
    return {
      id: 'nested-1',
      name: 'Nested',
      viewport: { panX: 0, panY: 0, zoom: 1 },
      elements: {
        byId: { [rect.id]: rect, [inner.id]: inner, [outer.id]: outer },
        order: [outer.id],
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    };
  }

  it('writes a group with its members inline and no childIds', () => {
    const project = makeNested();
    const [root] = serializeProject(project).elements;
    expect(root?.type).toBe('group');
    if (root?.type !== 'group') return;
    expect(root).not.toHaveProperty('childIds');
    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.type).toBe('group');
  });

  it('round-trips a nested group through JSON', () => {
    const project = makeNested();
    const restored = fromSerialized(
      JSON.parse(JSON.stringify(serializeProject(project))) as SerializedProject
    );
    expect(restored.elements).toEqual(project.elements);
  });

  it('puts only genuine roots in order, not a group member', () => {
    const project = makeNested();
    const result = deserializeProject(JSON.parse(JSON.stringify(serializeProject(project))));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const store = result.value.project.elements;
    expect(store.order).toEqual(project.elements.order);
    expect(Object.keys(store.byId)).toHaveLength(3);
    // The invariant nesting exists to guarantee: every non-root element is
    // reachable through exactly one parent, so paint order emits it once.
    expect(elementsInPaintOrder(store)).toHaveLength(3);
    for (const id of Object.keys(store.byId)) {
      const isRoot = store.order.includes(id);
      expect(parentOf(store, id) === null).toBe(isRoot);
    }
  });

  it('inlines an image that lives inside a group', () => {
    const project = makeNested();
    const image = ELEMENTS.find((element) => element.type === 'image');
    if (image === undefined) throw new Error('fixture has no image element');
    const rootId = project.elements.order[0];
    if (rootId === undefined) throw new Error('fixture has no root');
    const root = project.elements.byId[rootId];
    if (root?.type !== 'group') throw new Error('fixture root is not a group');

    const withImage: Project = {
      ...project,
      elements: {
        byId: {
          ...project.elements.byId,
          [image.id]: image,
          [rootId]: { ...root, childIds: [...root.childIds, image.id] },
        },
        order: project.elements.order,
      },
    };
    expect(serializeProject(withImage, { 'sha256-abc': PNG_DATA_URI }).images).toEqual({
      'sha256-abc': PNG_DATA_URI,
    });
  });

  it('writes a cyclic store once rather than recursing forever', () => {
    const a = createGroup([], { name: 'A' });
    const b = createGroup([a.id], { name: 'B' });
    const cyclic: Project = {
      ...makeNested(),
      elements: {
        byId: { [a.id]: { ...a, childIds: [b.id] }, [b.id]: b },
        order: [a.id],
      },
    };
    const [root] = serializeProject(cyclic).elements;
    expect(root?.type === 'group' && root.children).toHaveLength(1);
    if (root?.type !== 'group') return;
    const child = root.children[0];
    expect(child?.type === 'group' && child.children).toEqual([]);
  });
});
