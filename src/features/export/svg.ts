/**
 * SVG export: a second serializer that maps the element union to markup.
 *
 * Not the canvas renderer with a different backend - a separate mapping, which
 * is why it lives here and not in the engine. The renderer's job is pixels at
 * 60fps; this one's is a portable file. They share the *model*, not the code.
 *
 * ── Fidelity limits, stated rather than hidden ───────────────────────────────
 *
 * • **Text wrapping** is a *second* greedy word-wrap implementation, not the
 *   engine's - `features/export` may not depend on `features/canvas`. Given a
 *   2D context both call `measureText`, so ordinary prose breaks identically;
 *   they diverge on a single word wider than the box.
 * • **Text baseline** differs measurably, not sub-pixel. The canvas draws with
 *   `textBaseline: 'middle'`, putting line i at (i + 0.5)·fontSize·lineHeight;
 *   this file places a baseline at 0.8·fontSize + i·fontSize·lineHeight. The
 *   offset is a fraction of the font size. Fixing it properly means moving text
 *   measurement into a module below both, which is the right change if the
 *   divergence ever matters - see docs/decisions/001-rendering-engine.md.
 * • **Fonts are referenced, not embedded.** Opening the file on a machine
 *   without the family substitutes a fallback and reflows the text.
 * • **Freehand** uses the same quadratic-through-midpoints smoothing as the
 *   canvas, so the curve matches; caps and joins are approximations.
 * • **Dash patterns** are scaled by stroke width to match the canvas, but SVG
 *   dash phase at corners differs slightly from Canvas 2D.
 * • **Images** are inlined as data URIs. One whose blob is unavailable exports
 *   as a dashed placeholder rather than vanishing silently.
 * • **Groups** need every descendant present in the pool handed to
 *   `elementsToSvg` - the function treats its input as a flat bag, not just
 *   roots, and resolves a group's `childIds` against whatever that bag
 *   contains. A caller that hands over only the top-level elements gets a
 *   childless `<g>`, not a crash: the same degrade-gracefully rule that covers
 *   a missing image blob covers missing structure too.
 *
 * Everything user-supplied - names, text bodies, colours, alt text - is escaped
 * on the way in by `tag()`. A project file is untrusted input; a name
 * containing `</text><script>` must produce literal characters, not markup.
 */

import { childIdsOf, elementsToPaint, isGroup } from '@/features/elements/tree';
import { contentBounds } from '@/features/selection/bounds';
import {
  assertNever,
  type CanvasElement,
  type ElementId,
  type ElementStore,
  type GroupElement,
  type LinearElement,
  type SerializedProject,
  type TextElement,
} from '@/types';
import {
  escapeXml,
  flattenSerialized,
  fmt,
  fontShorthand,
  MarkerRegistry,
  poolToStore,
  smoothPathData,
  strokeAttrs,
  tag,
  wrapText,
  type Attrs,
} from './svgPrimitives';

// Re-exported so the whole export surface is reachable from one module.
export { escapeXml, fontShorthand, rotatedBounds, smoothPathData, wrapText } from './svgPrimitives';

export interface SvgExportOptions {
  /** World units of empty space around the content bounds. */
  readonly padding?: number;
  /** Paint behind the content. `null`/omitted leaves the SVG transparent. */
  readonly background?: string | null;
  /** Data URIs keyed by `ImageElement.imageKey`. */
  readonly images?: Readonly<Record<string, string>>;
}

const DEFAULT_PADDING = 24;
/** Fraction of the font size from the line-box top down to the baseline. */
const BASELINE_RATIO = 0.8;

/* ---------------------------------------------------------------- element -- */

function endpoints(element: LinearElement): Attrs {
  return {
    x1: element.x + element.start.x * element.width,
    y1: element.y + element.start.y * element.height,
    x2: element.x + element.end.x * element.width,
    y2: element.y + element.end.y * element.height,
  };
}

function box(element: CanvasElement): Attrs {
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

function textMarkup(element: TextElement): string {
  const font = fontShorthand(element);
  const { textAlign, fontSize, lineHeight } = element;
  const anchor = textAlign === 'center' ? 'middle' : textAlign === 'right' ? 'end' : 'start';
  const anchorX =
    textAlign === 'center'
      ? element.x + element.width / 2
      : textAlign === 'right'
        ? element.x + element.width
        : element.x;

  const tspans = wrapText(element.text, font, element.width, fontSize)
    .map((line, index) => {
      const y = element.y + fontSize * BASELINE_RATIO + index * fontSize * lineHeight;
      return tag('tspan', { x: anchorX, y }, escapeXml(line));
    })
    .join('');

  const attrs: Attrs = {
    'font-family': element.fontFamily,
    'font-size': fontSize,
    'font-weight': element.fontWeight,
    'font-style': element.italic ? 'italic' : null,
    fill: element.color,
    'text-anchor': anchor,
    // Without this, leading and trailing spaces in a line are collapsed away.
    'xml:space': 'preserve',
  };
  return tag('text', attrs, tspans);
}

function shapeMarkup(
  element: Exclude<CanvasElement, GroupElement>,
  markers: MarkerRegistry,
  images: Readonly<Record<string, string>>
): string {
  switch (element.type) {
    case 'rectangle': {
      const radius = Math.min(element.cornerRadius, element.width / 2, element.height / 2);
      const attrs: Attrs = {
        ...box(element),
        rx: radius > 0 ? radius : null,
        fill: element.fill ?? 'none',
        ...strokeAttrs(element),
      };
      return tag('rect', attrs);
    }
    case 'ellipse': {
      const attrs: Attrs = {
        cx: element.x + element.width / 2,
        cy: element.y + element.height / 2,
        rx: element.width / 2,
        ry: element.height / 2,
        fill: element.fill ?? 'none',
        ...strokeAttrs(element),
      };
      return tag('ellipse', attrs);
    }
    case 'line':
      return tag('line', { ...endpoints(element), ...strokeAttrs(element) });

    case 'arrow': {
      const color = element.stroke ?? '#000000';
      const attrs: Attrs = {
        ...endpoints(element),
        ...strokeAttrs(element),
        'marker-start': markers.ref(element.arrowheadStart, color),
        'marker-end': markers.ref(element.arrowheadEnd, color),
      };
      return tag('line', attrs);
    }
    case 'text':
      return textMarkup(element);

    case 'image': {
      const href = images[element.imageKey];
      // A missing blob becomes a visible placeholder: more honest than a hole
      // the user only discovers after sharing the file.
      if (href === undefined) {
        const attrs: Attrs = {
          ...box(element),
          fill: 'none',
          stroke: '#b04a6a',
          'stroke-dasharray': '4 3',
        };
        return tag('rect', attrs);
      }
      return tag('image', { href, ...box(element), preserveAspectRatio: 'none' });
    }
    case 'freehand': {
      const absolute = element.points.map((point) => ({
        x: element.x + point.x * element.width,
        y: element.y + point.y * element.height,
      }));
      return tag('path', { d: smoothPathData(absolute), fill: 'none', ...strokeAttrs(element) });
    }
    default:
      return assertNever(element, 'element type in SVG export');
  }
}

/**
 * Each element is wrapped in a `<g>` so rotation, opacity, and the accessible
 * name are applied uniformly instead of per shape type - except a `GroupElement`
 * is exempt from the rotation half of that. Its doc comment is explicit that
 * `rotation` is always 0 and the box is a derived cache, so a transform here
 * would be attaching geometry to a container that owns none. This branch
 * never reads `element.rotation` for a group at all, rather than trusting the
 * invariant to hold - the design decision is enforced here, not assumed.
 */
function elementMarkup(
  store: ElementStore,
  element: CanvasElement,
  markers: MarkerRegistry,
  images: Readonly<Record<string, string>>,
  rendered: Set<ElementId>
): string {
  // `rendered` is shared across the whole export, not per root or per branch -
  // see `groupChildrenMarkup`'s doc comment for why a per-path guard isn't enough.
  if (rendered.has(element.id)) return '';
  rendered.add(element.id);

  // `<title>` is the element's accessible name and its tooltip. It is also the
  // most obvious injection point in the document, hence escaped like the rest.
  const title = element.name.length > 0 ? tag('title', {}, escapeXml(element.name)) : '';
  const opacity = element.opacity >= 1 ? null : element.opacity;

  if (isGroup(element)) {
    const children = groupChildrenMarkup(store, element, markers, images, rendered);
    return tag('g', { opacity }, title + children);
  }

  const degrees = (element.rotation * 180) / Math.PI;
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  const attrs: Attrs = {
    transform: element.rotation === 0 ? null : `rotate(${fmt(degrees)} ${fmt(cx)} ${fmt(cy)})`,
    opacity,
  };
  return tag('g', attrs, title + shapeMarkup(element, markers, images));
}

/**
 * A group's members, each recursed through `elementMarkup` in its own right -
 * so a group two levels deep produces a `<g>` inside a `<g>`, matching the
 * tree the store holds rather than flattening it into paint order.
 *
 * `rendered` is `tree.ts#walkChildren`'s visited set, carried by hand: this is
 * a structural recursion over `childIds`, not a call into `walkChildren`, so
 * it defends itself the same way - but as *one* set shared across the whole
 * export (created once in `elementsToSvg`), not a fresh set per root or a
 * clone per level. A per-path set would stop a group from containing itself
 * but would miss the same id reachable through two different paths (listed
 * twice in one group's `childIds`, or claimed by two separate groups) -
 * exactly the case `walkChildren`'s shared `visited` set exists to rule out
 * elsewhere. `elementMarkup` marks an id rendered before recursing into it, so
 * one set gives both guarantees: a self-reference and an innocuous duplicate
 * hit the same already-rendered check and stop there.
 */
function groupChildrenMarkup(
  store: ElementStore,
  group: GroupElement,
  markers: MarkerRegistry,
  images: Readonly<Record<string, string>>,
  rendered: Set<ElementId>
): string {
  return childIdsOf(store, group.id)
    .map((childId) => store.byId[childId])
    .filter((child): child is CanvasElement => child !== undefined && child.visible)
    .map((child) => elementMarkup(store, child, markers, images, rendered))
    .join('');
}

/* ----------------------------------------------------------------- export -- */

export function elementsToSvg(
  elements: readonly CanvasElement[],
  options: SvgExportOptions = {}
): string {
  const padding = options.padding ?? DEFAULT_PADDING;
  const images = options.images ?? {};
  const store = poolToStore(elements);
  const roots = store.order
    .map((id) => store.byId[id])
    .filter((element): element is CanvasElement => element !== undefined && element.visible);

  // Framed on what actually paints, not on `roots` itself: a root can be a
  // group, and a group's own box is a *derived cache* of every descendant,
  // hidden ones included (`deriveGroupRect`). Framing on that would reserve
  // room for content this very export drops a few lines down. `elementsToPaint`
  // is the recursive, visibility-aware walk that already answers "what will
  // actually be drawn" for the renderer and for PNG; using the same
  // `contentBounds` over it here is what makes this frame agree with the
  // dialog's own estimate (`ExportDialog.tsx`), instead of the two silently
  // diverging the moment a group has a hidden member.
  const bounds = contentBounds(elementsToPaint(store)) ?? { x: 0, y: 0, width: 1, height: 1 };
  const frame = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };

  const markers = new MarkerRegistry();
  // One `rendered` set for the whole export, not one per root - see
  // `groupChildrenMarkup`'s doc comment for why a fresh set per root would
  // undercount an id reachable through two different roots' trees.
  const rendered = new Set<ElementId>();
  // Bodies first: the registry only knows which markers were referenced once
  // every element has been visited, and `<defs>` must precede its references.
  const body = roots
    .map((element) => elementMarkup(store, element, markers, images, rendered))
    .join('');
  const background =
    options.background == null ? '' : tag('rect', { ...frame, fill: options.background });

  const attrs: Attrs = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: frame.width,
    height: frame.height,
    viewBox: `${fmt(frame.x)} ${fmt(frame.y)} ${fmt(frame.width)} ${fmt(frame.height)}`,
  };
  return tag('svg', attrs, markers.defs() + background + body);
}

/** Convenience for the export dialog: a serialized document already carries its images. */
export function serializedProjectToSvg(
  project: SerializedProject,
  options: Omit<SvgExportOptions, 'images'> = {}
): string {
  return elementsToSvg(flattenSerialized(project.elements), { ...options, images: project.images });
}
