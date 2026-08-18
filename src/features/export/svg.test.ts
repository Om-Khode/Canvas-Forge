import { describe, expect, it } from 'vitest';
import type { CanvasElement, SerializedElement, SerializedProject } from '@/types';
import { elementsToSvg, escapeXml, rotatedBounds, serializedProjectToSvg, smoothPathData } from './svg';

function base(overrides: Partial<CanvasElement> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    name: 'Element',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    ...overrides,
  };
}

const rect = (overrides: Record<string, unknown> = {}): CanvasElement =>
  ({
    ...base(),
    type: 'rectangle',
    stroke: '#1c1c1f',
    strokeWidth: 2,
    strokeStyle: 'solid',
    fill: '#ffffff',
    cornerRadius: 6,
    ...overrides,
  }) as CanvasElement;

const group = (childIds: readonly string[], overrides: Record<string, unknown> = {}): CanvasElement =>
  ({
    ...base({ id: 'outer' }),
    type: 'group',
    width: 0,
    height: 0,
    childIds,
    ...overrides,
  }) as CanvasElement;

describe('escaping', () => {
  it('escapes every XML metacharacter', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('cannot be broken out of by a hostile element name', () => {
    const svg = elementsToSvg([rect({ name: '</title><script>alert(1)</script>' })]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('cannot be broken out of by a hostile text body or attribute value', () => {
    const hostile: CanvasElement = {
      ...base(),
      type: 'text',
      text: '</text><script>alert("xss")</script>',
      fontFamily: 'sans-serif" onload="alert(1)',
      fontSize: 16,
      fontWeight: 400,
      italic: false,
      textAlign: 'left',
      lineHeight: 1.35,
      color: '#000000',
      autoHeight: true,
    } as CanvasElement;

    const svg = elementsToSvg([hostile]);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('onload="');
    expect(svg).toContain('&lt;script&gt;');
    // The attribute value survives as data, with its quote neutralised.
    expect(svg).toContain('font-family="sans-serif&quot; onload=&quot;alert(1)"');
  });
});

describe('document frame', () => {
  it('frames the content bounds with padding', () => {
    const svg = elementsToSvg([rect({ x: 10, y: 20, width: 100, height: 50 })], { padding: 5 });
    expect(svg).toContain('viewBox="5 15 110 60"');
    expect(svg).toContain('width="110"');
  });

  it('produces a valid frame for an empty document', () => {
    const svg = elementsToSvg([], { padding: 0 });
    expect(svg).toContain('viewBox="0 0 1 1"');
  });

  it('excludes hidden elements from the output and the bounds', () => {
    const svg = elementsToSvg([rect({ id: 'a' }), rect({ id: 'b', x: 5000, visible: false })], {
      padding: 0,
    });
    expect(svg).toContain('viewBox="0 0 100 50"');
  });

  it('paints a background only when asked', () => {
    expect(elementsToSvg([rect()])).not.toContain('<rect x="-24"');
    expect(elementsToSvg([rect()], { background: '#ffffff' })).toContain('fill="#ffffff"');
  });
});

describe('element mapping', () => {
  it('emits rx for a rounded rectangle and clamps it to half the shorter side', () => {
    expect(elementsToSvg([rect({ cornerRadius: 6 })])).toContain('rx="6"');
    expect(elementsToSvg([rect({ cornerRadius: 400 })])).toContain('rx="25"');
  });

  it('applies rotation as a transform about the element centre', () => {
    const svg = elementsToSvg([rect({ rotation: Math.PI / 2 })]);
    expect(svg).toContain('transform="rotate(90 50 25)"');
  });

  it('omits the transform when the element is unrotated', () => {
    expect(elementsToSvg([rect()])).not.toContain('rotate(');
  });

  it('maps an ellipse to centre and radii', () => {
    const svg = elementsToSvg([rect({ type: 'ellipse' })]);
    expect(svg).toContain('<ellipse cx="50" cy="25" rx="50" ry="25"');
  });

  it('scales the dash pattern by stroke width', () => {
    const svg = elementsToSvg([rect({ strokeStyle: 'dashed', strokeWidth: 2 })]);
    expect(svg).toContain('stroke-dasharray="8 6"');
  });

  it('defines one marker per arrowhead style and colour, not one per arrow', () => {
    const arrow = (id: string): CanvasElement =>
      ({
        ...base({ id }),
        type: 'arrow',
        stroke: '#c2603f',
        strokeWidth: 2,
        strokeStyle: 'solid',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        arrowheadStart: 'none',
        arrowheadEnd: 'triangle',
      }) as CanvasElement;

    const svg = elementsToSvg([arrow('a1'), arrow('a2')]);
    expect(svg.match(/<marker/g)).toHaveLength(1);
    expect(svg.match(/marker-end=/g)).toHaveLength(2);
    expect(svg).not.toContain('marker-start=');
    // The def has to precede the references for a strict SVG consumer.
    expect(svg.indexOf('<defs>')).toBeLessThan(svg.indexOf('marker-end='));
  });

  it('denormalizes line endpoints into the bounding box', () => {
    const line = {
      ...base({ x: 10, y: 10, width: 100, height: 40 }),
      type: 'line',
      stroke: '#000000',
      strokeWidth: 1,
      strokeStyle: 'solid',
      start: { x: 0, y: 0.5 },
      end: { x: 1, y: 0.5 },
    } as CanvasElement;
    expect(elementsToSvg([line])).toContain('<line x1="10" y1="30" x2="110" y2="30"');
  });

  it('emits one tspan per wrapped line of text', () => {
    const text = {
      ...base(),
      type: 'text',
      text: 'one\ntwo\nthree',
      fontFamily: 'sans-serif',
      fontSize: 10,
      fontWeight: 400,
      italic: false,
      textAlign: 'center',
      lineHeight: 2,
      color: '#111111',
      autoHeight: true,
    } as CanvasElement;
    const svg = elementsToSvg([text]);
    expect(svg.match(/<tspan/g)).toHaveLength(3);
    expect(svg).toContain('text-anchor="middle"');
    // baseline = y + 0.8 * fontSize + index * fontSize * lineHeight
    expect(svg).toContain('y="8"');
    expect(svg).toContain('y="28"');
  });

  it('inlines an image when the data URI is available and placeholders it when not', () => {
    const image = {
      ...base(),
      type: 'image',
      imageKey: 'k1',
      naturalWidth: 100,
      naturalHeight: 50,
      alt: 'photo',
    } as CanvasElement;

    const withData = elementsToSvg([image], { images: { k1: 'data:image/png;base64,AAAA' } });
    expect(withData).toContain('<image href="data:image/png;base64,AAAA"');

    const withoutData = elementsToSvg([image]);
    expect(withoutData).not.toContain('<image');
    expect(withoutData).toContain('stroke-dasharray="4 3"');
  });

  it('smooths a freehand stroke through the midpoints of its points', () => {
    expect(smoothPathData([{ x: 0, y: 0 }])).toBe('M 0 0 l 0.01 0');
    expect(
      smoothPathData([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 10 },
      ])
    ).toBe('M 0 0 Q 10 0 15 5 L 20 10');
  });
});

describe('groups', () => {
  const NESTED_ELEMENTS = [rect({ id: 'child' }), group(['child'])];
  const GROUP_AT_HALF_OPACITY = [rect({ id: 'child' }), group(['child'], { opacity: 0.5 })];

  it('mirrors the group tree as nested <g> elements', () => {
    const svg = elementsToSvg(NESTED_ELEMENTS, { images: {} });
    expect(svg).toMatch(/<g[^>]*>[\s\S]*<rect[\s\S]*<\/g>/);
  });

  it('carries group opacity onto the <g> and no transform', () => {
    // Transforms bake into children, so a group has nothing to transform by.
    const svg = elementsToSvg(GROUP_AT_HALF_OPACITY, { images: {} });
    expect(svg).toContain('opacity="0.5"');
    expect(svg).not.toMatch(/<g[^>]*transform=/);
  });

  it('renders a grouped child once, not once nested and once at the top level', () => {
    const svg = elementsToSvg(NESTED_ELEMENTS, { images: {} });
    expect(svg.match(/<rect/g)).toHaveLength(1);
  });

  it('drops a hidden child from its group without dropping the group itself', () => {
    const svg = elementsToSvg([rect({ id: 'child', visible: false }), group(['child'])], {
      images: {},
    });
    expect(svg).not.toContain('<rect');
    // The group itself still renders - visibility is per element, not
    // inherited by a group from whether any of its children happen to show.
    expect(svg).toContain('<g>');
  });

  it('nests groups within groups, one <g> per level', () => {
    const inner = group(['child'], { id: 'inner' });
    const outer = group(['inner'], { id: 'outer' });
    const svg = elementsToSvg([rect({ id: 'child' }), inner, outer], { images: {} });
    // One <g> each for outer, inner, and the rect's own rotation/opacity wrapper.
    expect(svg.match(/<g/g)).toHaveLength(3);
    expect(svg).toMatch(/<rect/);
  });

  it('escapes a hostile group name reaching its <title>', () => {
    const hostile = [
      rect({ id: 'child' }),
      group(['child'], { name: '</title><script>alert(1)</script>' }),
    ];
    const svg = elementsToSvg(hostile, { images: {} });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('flattens a nested serialized group before export', () => {
    const serializedChild = rect({ id: 'child' }) as unknown as SerializedElement;
    const serializedGroup = {
      ...base({ id: 'outer' }),
      type: 'group',
      width: 0,
      height: 0,
      children: [serializedChild],
    } as unknown as SerializedElement;

    const project: SerializedProject = {
      schemaVersion: 2,
      id: 'p1',
      name: 'Project',
      viewport: { panX: 0, panY: 0, zoom: 1 },
      metadata: { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' },
      images: {},
      elements: [serializedGroup],
    };

    const svg = serializedProjectToSvg(project);
    expect(svg).toMatch(/<g[^>]*>[\s\S]*<rect[\s\S]*<\/g>/);
  });

  it('renders an element once even when two different groups claim it as a child', () => {
    // Grouping ships in a later task, so nothing in the store yet stops a
    // `childIds` list from claiming an id another group already claims - this
    // is a state the exporter has to defend against on its own, not one the
    // `rect`/`group` helpers above are built to produce. Written as literals
    // rather than through those helpers, matching the review's ask to reach
    // this state directly instead of via a factory.
    const child: CanvasElement = {
      id: 'child',
      name: 'Child',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      type: 'rectangle',
      stroke: '#000000',
      strokeWidth: 1,
      strokeStyle: 'solid',
      fill: '#ffffff',
      cornerRadius: 0,
    };

    const groupA: CanvasElement = {
      id: 'groupA',
      name: 'Group A',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      type: 'group',
      childIds: ['child'],
    };

    const groupB: CanvasElement = {
      id: 'groupB',
      name: 'Group B',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      type: 'group',
      childIds: ['child'],
    };

    const svg = elementsToSvg([child, groupA, groupB], { images: {} });
    expect(svg.match(/<rect/g)).toHaveLength(1);
  });
});

describe('rotatedBounds', () => {
  it('returns the plain box when unrotated', () => {
    expect(rotatedBounds(rect({ x: 1, y: 2 }))).toEqual({ x: 1, y: 2, width: 100, height: 50 });
  });

  it('grows the box for a rotated element', () => {
    const bounds = rotatedBounds(rect({ rotation: Math.PI / 2 }));
    expect(bounds.width).toBeCloseTo(50);
    expect(bounds.height).toBeCloseTo(100);
    expect(bounds.x).toBeCloseTo(25);
  });
});
