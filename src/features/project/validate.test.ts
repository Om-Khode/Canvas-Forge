import { describe, expect, it } from 'vitest';
import { MAX_GROUP_DEPTH } from '@/constants/storage';
import { isAcceptedDataUri, validateElement, validateSerializedProject } from './validate';

const GOOD_RECT = {
  id: 'rect-1',
  type: 'rectangle',
  name: 'Card',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  stroke: '#1c1c1f',
  strokeWidth: 2,
  strokeStyle: 'solid',
  fill: '#ffffff',
  cornerRadius: 4,
};

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'p1',
    name: 'Doc',
    viewport: { panX: 0, panY: 0, zoom: 1 },
    elements: [GOOD_RECT],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    images: {},
    ...overrides,
  };
}

describe('validateElement', () => {
  it('drops an element with no id', () => {
    const result = validateElement({ ...GOOD_RECT, id: '' });
    expect(result.ok).toBe(false);
  });

  it('drops an element of an unknown type', () => {
    const result = validateElement({ ...GOOD_RECT, type: 'hexagon' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown element type');
  });

  it('clamps opacity into 0..1 rather than rejecting', () => {
    const high = validateElement({ ...GOOD_RECT, opacity: 4 });
    const low = validateElement({ ...GOOD_RECT, opacity: -3 });
    expect(high.ok && high.value.opacity).toBe(1);
    expect(low.ok && low.value.opacity).toBe(0);
  });

  it('replaces non-finite coordinates with zero and negative sizes with zero', () => {
    const result = validateElement({
      ...GOOD_RECT,
      x: Number.NaN,
      y: Infinity,
      width: -50,
      height: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.x).toBe(0);
    expect(result.value.y).toBe(0);
    expect(result.value.width).toBe(0);
    expect(result.value.height).toBe(20);
  });

  it('falls back on unparseable enum values', () => {
    const result = validateElement({ ...GOOD_RECT, strokeStyle: 'wavy' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type === 'rectangle' && result.value.strokeStyle).toBe('solid');
  });

  it('rejects a colour that is a paint-server reference', () => {
    const result = validateElement({ ...GOOD_RECT, fill: 'url(https://evil.example/x.svg#p)' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type === 'rectangle' && result.value.fill).toBe(null);
  });

  it('drops an image element with no key', () => {
    const result = validateElement({ ...GOOD_RECT, type: 'image', imageKey: 42 });
    expect(result.ok).toBe(false);
  });

  it('drops a freehand element with no usable points', () => {
    expect(validateElement({ ...GOOD_RECT, type: 'freehand', points: [] }).ok).toBe(false);
    expect(validateElement({ ...GOOD_RECT, type: 'freehand' }).ok).toBe(false);
  });

  it('keeps a text element and defaults its missing typography', () => {
    const result = validateElement({ ...GOOD_RECT, type: 'text', text: 'hi', fontWeight: 999 });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.type !== 'text') return;
    expect(result.value.text).toBe('hi');
    expect(result.value.fontWeight).toBe(400);
  });
});

describe('validateSerializedProject', () => {
  it('loads the rest of the document when one element is bad', () => {
    const result = validateSerializedProject(
      doc({ elements: [GOOD_RECT, { type: 'rectangle' }, { ...GOOD_RECT, id: 'rect-2' }] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project.elements.map((element) => element.id)).toEqual([
      'rect-1',
      'rect-2',
    ]);
    expect(result.value.warnings).toHaveLength(1);
    expect(result.value.warnings[0]).toContain('Dropped element 1');
  });

  it('drops duplicate ids and reports them', () => {
    const result = validateSerializedProject(doc({ elements: [GOOD_RECT, GOOD_RECT] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project.elements).toHaveLength(1);
    expect(result.value.warnings[0]).toContain('duplicate id');
  });

  it('refuses input that is not an object', () => {
    for (const input of [null, 42, 'x', [GOOD_RECT]]) {
      const result = validateSerializedProject(input);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a document with no elements array', () => {
    const result = validateSerializedProject(doc({ elements: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-shape');
  });

  it('clamps an out-of-range zoom', () => {
    const result = validateSerializedProject(doc({ viewport: { panX: 0, panY: 0, zoom: 10_000 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project.viewport.zoom).toBe(64);
  });

  it('repairs an invalid timestamp instead of failing', () => {
    const result = validateSerializedProject(
      doc({ metadata: { createdAt: 'yesterday', updatedAt: 7 } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isNaN(Date.parse(result.value.project.metadata.createdAt))).toBe(false);
    expect(result.value.project.metadata.updatedAt).toBe(result.value.project.metadata.createdAt);
  });

  it('drops image entries whose data URI is not an accepted image type', () => {
    const result = validateSerializedProject(
      doc({
        images: {
          good: 'data:image/png;base64,iVBORw0KGgo=',
          html: 'data:text/html;base64,PHNjcmlwdD4=',
          remote: 'https://evil.example/pixel.png',
          script: 'javascript:alert(1)',
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.project.images)).toEqual(['good']);
    expect(result.value.warnings).toHaveLength(3);
  });
});

describe('nested groups', () => {
  function group(id: string, children: readonly unknown[]): Record<string, unknown> {
    return { ...GOOD_RECT, id, type: 'group', name: id, children };
  }

  function rect(id: string): Record<string, unknown> {
    return { ...GOOD_RECT, id };
  }

  it('accepts a nested group and keeps the members inline', () => {
    const result = validateSerializedProject(
      doc({ elements: [group('g1', [group('g2', [rect('r1')])])] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toEqual([]);

    const [root] = result.value.project.elements;
    expect(root?.type).toBe('group');
    if (root?.type !== 'group') return;
    const child = root.children[0];
    expect(child?.type === 'group' && child.children[0]?.id).toBe('r1');
  });

  it('drops a group whose children are not an array', () => {
    const result = validateSerializedProject(
      doc({ elements: [{ ...GOOD_RECT, id: 'g1', type: 'group', childIds: ['r1'] }] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project.elements).toEqual([]);
    expect(result.value.warnings[0]).toContain('no children array');
  });

  it('drops a nested element that repeats an id claimed elsewhere', () => {
    const result = validateSerializedProject(
      doc({ elements: [rect('r1'), group('g1', [rect('r1'), rect('r2')])] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const root = result.value.project.elements[1];
    expect(root?.type === 'group' && root.children.map((child) => child.id)).toEqual(['r2']);
    expect(result.value.warnings[0]).toContain('Dropped element 1.0: duplicate id r1');
  });

  it('says a subtree was dropped when the duplicate is a group, not just the group', () => {
    const result = validateSerializedProject(
      doc({
        elements: [{ ...GOOD_RECT, id: 'g1' }, group('g1', [rect('r1'), rect('r2')])],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The whole subtree - r1 and r2 - went with the dropped group: neither
    // was claimed by anything else, so they must not resurface anywhere.
    expect(result.value.project.elements).toHaveLength(1);
    // Root-level path stays a bare index, matching the existing
    // `Dropped element 1: …` assertions elsewhere in this file.
    expect(result.value.warnings[0]).toBe(
      'Dropped element 1: duplicate id g1 and everything inside it.'
    );
  });

  it('does not append the subtree note when the duplicate is a leaf', () => {
    const result = validateSerializedProject(doc({ elements: [rect('r1'), rect('r1')] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings[0]).toBe('Dropped element 1: duplicate id r1.');
  });

  it('drops a group that contains itself instead of recursing', () => {
    const selfReference: Record<string, unknown> = group('g1', []);
    selfReference.children = [selfReference];

    const result = validateSerializedProject(doc({ elements: [selfReference] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const root = result.value.project.elements[0];
    expect(root?.type === 'group' && root.children).toEqual([]);
    expect(result.value.warnings[0]).toContain('duplicate id g1');
  });

  it('keeps a group whose children were all dropped rather than cascading', () => {
    const result = validateSerializedProject(
      doc({ elements: [group('g1', [{ type: 'rectangle' }])] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const root = result.value.project.elements[0];
    expect(root?.type === 'group' && root.children).toEqual([]);
    expect(result.value.warnings).toHaveLength(1);
  });

  it('reports a nested element by its path through the file', () => {
    const result = validateSerializedProject(
      doc({ elements: [rect('r0'), group('g1', [rect('r1'), { type: 'rectangle' }])] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings[0]).toContain('Dropped element 1.1');
  });
});

describe('depth limit', () => {
  it('drops a subtree nested past MAX_GROUP_DEPTH and reports it', () => {
    // A hostile file can nest deep enough to overflow the stack on any
    // recursive walk. The cap is the only thing standing between untrusted
    // input and a crash.
    let node: unknown = GOOD_RECT;
    for (let i = 0; i < MAX_GROUP_DEPTH + 5; i++) {
      node = { ...GOOD_RECT, id: `g${i}`, type: 'group', children: [node] };
    }

    const result = validateSerializedProject(doc({ elements: [node] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.join(' ')).toMatch(/depth/i);
    // One warning, not one per level: the cap fires at the boundary and
    // everything below it is inside the subtree that was never visited.
    expect(result.value.warnings).toHaveLength(1);
  });

  it('accepts a document nested exactly to the cap', () => {
    let node: unknown = GOOD_RECT;
    // The rect is the deepest level, so MAX_GROUP_DEPTH - 1 groups above it
    // puts the leaf at exactly MAX_GROUP_DEPTH.
    for (let i = 0; i < MAX_GROUP_DEPTH - 1; i++) {
      node = { ...GOOD_RECT, id: `g${i}`, type: 'group', children: [node] };
    }

    const result = validateSerializedProject(doc({ elements: [node] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toEqual([]);
  });
});

describe('isAcceptedDataUri', () => {
  it('accepts every configured image type and nothing else', () => {
    expect(isAcceptedDataUri('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isAcceptedDataUri('data:image/svg+xml,%3Csvg%3E')).toBe(true);
    expect(isAcceptedDataUri('data:image/tiff;base64,AAAA')).toBe(false);
    expect(isAcceptedDataUri('data:,hello')).toBe(false);
    expect(isAcceptedDataUri(12)).toBe(false);
  });
});
