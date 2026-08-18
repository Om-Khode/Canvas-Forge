/**
 * Low-level building blocks for SVG export: escaping, tag construction,
 * geometry, path smoothing, and text metrics.
 *
 * Split out of `svg.ts` purely for size - that file is the element→markup
 * mapping and nothing else, and this one is the vocabulary it is written in.
 * Everything public here is re-exported from `svg.ts`, so consumers still have
 * a single import.
 */

import { DEFAULT_ARROWHEAD_SIZE, STROKE_DASH_PATTERNS } from '@/constants/defaults';
import { isGroup } from '@/features/elements/tree';
import type {
  ArrowheadStyle,
  CanvasElement,
  ElementId,
  ElementStore,
  Rect,
  SerializedElement,
  StrokableElement,
  TextElement,
  Vec2,
} from '@/types';

/** Fallback glyph width as a fraction of font size, when text can't be measured. */
const ESTIMATED_GLYPH_RATIO = 0.52;

/* -------------------------------------------------------------- escaping -- */

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** One escaper for text and attributes: over-escaping text is harmless, under-escaping is not. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** Three decimals: small files, no visible drift at export scale. */
export function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0';
}

export type Attrs = Readonly<Record<string, string | number | null>>;

/**
 * Every tag goes through here, so escaping is structural rather than something
 * each call site has to remember. `null` omits an attribute and numbers are
 * formatted, which is what keeps the per-element mappings to one expression.
 */
export function tag(name: string, attrs: Attrs, children?: string): string {
  let out = `<${name}`;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null) continue;
    out += ` ${key}="${escapeXml(typeof value === 'number' ? fmt(value) : value)}"`;
  }
  return children === undefined ? `${out}/>` : `${out}>${children}</${name}>`;
}

/* ---------------------------------------------------------------- bounds -- */

/** Axis-aligned bounds of an element *after* rotation about its centre. */
export function rotatedBounds(element: CanvasElement): Rect {
  const { x, y, width, height, rotation } = element;
  if (rotation === 0 || !Number.isFinite(rotation)) return { x, y, width, height };

  const cx = x + width / 2;
  const cy = y + height / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ] as const) {
    const dx = px - cx;
    const dy = py - cy;
    xs.push(cx + dx * cos - dy * sin);
    ys.push(cy + dx * sin + dy * cos);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/*
 * `contentBounds` used to have a second copy here - a naive union over
 * whatever array it was handed, with no idea that an element could be a group.
 * `svg.ts` now imports the one real implementation from
 * `features/selection/bounds`, which knows a group's own box is a derived
 * cache that can include hidden descendants and skips it accordingly. Two
 * functions with the same name and different answers for the same input is
 * the bug Task 12's fix-round found; removing the second one is the fix,
 * not documenting it as intentional - nothing here depended on the naive
 * version's behaviour once `svg.ts` was pointed at the shared one.
 */

/* ------------------------------------------------------------------ tree -- */

/**
 * Turns a flat pool into the `{ byId, order }` shape `svg.ts` recurses
 * through. "Pool" rather than "roots" is deliberate: the caller may have
 * handed over every element at every depth (an `ElementStore.byId` flattened
 * once, say), so membership - not the array's own order - is what decides a
 * root. Anything named in some group's `childIds` renders once, inside that
 * group; everything else renders once, at the top level. A pool with no
 * groups at all - every existing call site, today - leaves `order` identical
 * to `elements`, so this changes nothing for the common case.
 */
export function poolToStore(elements: readonly CanvasElement[]): ElementStore {
  const byId: Record<ElementId, CanvasElement> = {};
  const nested = new Set<ElementId>();
  for (const element of elements) {
    byId[element.id] = element;
    if (isGroup(element)) for (const childId of element.childIds) nested.add(childId);
  }
  const order = elements.filter((element) => !nested.has(element.id)).map((element) => element.id);
  return { byId, order };
}

/**
 * `SerializedProject.elements` nests a group's members inline as `children`
 * (`types/project.ts`), not by id - a different shape from the `childIds`
 * pool `poolToStore` expects, chosen there for a reason that happens to make
 * this conversion safe: nesting cannot express a cycle, so unlike a
 * `childIds` walk this recursion needs no guard against one.
 */
export function flattenSerialized(elements: readonly SerializedElement[]): CanvasElement[] {
  const out: CanvasElement[] = [];
  for (const element of elements) {
    if ('children' in element) {
      const { children, ...group } = element;
      out.push({ ...group, childIds: children.map((child) => child.id) });
      out.push(...flattenSerialized(children));
    } else {
      out.push(element);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- paint -- */

export function strokeAttrs(element: StrokableElement): Attrs {
  if (element.stroke === null || element.strokeWidth <= 0) return { stroke: 'none' };
  const pattern = STROKE_DASH_PATTERNS[element.strokeStyle];
  return {
    stroke: element.stroke,
    'stroke-width': element.strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    // Scaled by stroke width so a dash reads the same at any weight, matching
    // how the canvas drawer sets its dash array.
    'stroke-dasharray':
      pattern.length > 0 ? pattern.map((d) => fmt(d * element.strokeWidth)).join(' ') : null,
  };
}

/**
 * Arrowheads are `<marker>` defs rather than inline paths, so the geometry is
 * expressed once and SVG orients it along the line. Deduplicated by
 * (style, colour): fifty same-coloured arrows emit one def, not fifty.
 */
export class MarkerRegistry {
  private readonly ids = new Map<string, string>();

  /** Returns a `url(#id)` reference, registering the def on first use. */
  ref(style: ArrowheadStyle, color: string): string | null {
    if (style === 'none') return null;
    const cacheKey = `${style}|${color}`;
    const existing = this.ids.get(cacheKey);
    if (existing) return `url(#${existing})`;
    const id = `cf-arrow-${style}-${this.ids.size}`;
    this.ids.set(cacheKey, id);
    return `url(#${id})`;
  }

  defs(): string {
    if (this.ids.size === 0) return '';
    const size = DEFAULT_ARROWHEAD_SIZE / 2;
    const markers = [...this.ids].map(([cacheKey, id]) => {
      const [style, color = '#000000'] = cacheKey.split('|');
      const shape =
        style === 'triangle'
          ? tag('path', { d: 'M0,0 L10,5 L0,10 z', fill: color })
          : tag('path', {
              d: 'M0,0 L10,5 L0,10',
              fill: 'none',
              stroke: color,
              'stroke-width': 1.5,
            });
      // `auto-start-reverse` is what lets one def serve both ends of a line.
      const attrs: Attrs = {
        id,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: size,
        markerHeight: size,
        orient: 'auto-start-reverse',
        markerUnits: 'strokeWidth',
      };
      return tag('marker', attrs, shape);
    });
    return `<defs>${markers.join('')}</defs>`;
  }
}

/* -------------------------------------------------------------- freehand -- */

/**
 * Quadratic through midpoints: each recorded point is a control point and the
 * curve passes through the midpoint of each consecutive pair. The cheapest
 * smoothing that is C1-continuous, which is why the canvas renderer uses it -
 * reimplemented here rather than imported, because export must not depend on
 * the engine.
 */
export function smoothPathData(points: readonly Vec2[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return '';
  // A single-point stroke is a dot: a hairline segment makes it render at all.
  if (points.length === 1) return `M ${fmt(first.x)} ${fmt(first.y)} l 0.01 0`;

  let d = `M ${fmt(first.x)} ${fmt(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const control = points[i];
    const next = points[i + 1];
    if (!control || !next) continue;
    const midX = (control.x + next.x) / 2;
    const midY = (control.y + next.y) / 2;
    d += ` Q ${fmt(control.x)} ${fmt(control.y)} ${fmt(midX)} ${fmt(midY)}`;
  }
  return `${d} L ${fmt(last.x)} ${fmt(last.y)}`;
}

/* ------------------------------------------------------------------ text -- */

let measureContext: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext !== undefined) return measureContext;
  try {
    measureContext =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  } catch {
    measureContext = null;
  }
  return measureContext;
}

/** The CSS `font` shorthand the canvas would set for this element. */
export function fontShorthand(element: TextElement): string {
  const style = element.italic ? 'italic ' : '';
  return `${style}${element.fontWeight} ${element.fontSize}px ${element.fontFamily}`;
}

function measureWidth(text: string, font: string, fontSize: number): number {
  const ctx = getMeasureContext();
  if (!ctx) return text.length * ESTIMATED_GLYPH_RATIO * fontSize;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Greedy word wrap: explicit newlines are hard breaks, words are appended while
 * they fit, and a single word wider than the box overflows rather than being
 * broken mid-word. Measured with the same `measureText` the canvas uses, so in
 * a browser the exported line breaks match what is on screen.
 */
export function wrapText(text: string, font: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const candidate = current + word;
      if (current !== '' && maxWidth > 0 && measureWidth(candidate, font, fontSize) > maxWidth) {
        lines.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}
