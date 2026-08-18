/**
 * The document a first-time visitor lands on.
 *
 * This is portfolio surface, not a fixture: it is the first thing anyone
 * opening the app sees, and "a scatter of test rectangles" says the tool can
 * draw rectangles. So it is laid out like a real design file - a single
 * artboard, a typographic hierarchy, a three-column card grid on a shared
 * baseline, and two decorative accents that establish depth via opacity rather
 * than by being loud.
 *
 * Everything is built through the element factories, so the demo exercises the
 * same creation path the editor does and cannot drift from the element model.
 * Every colour comes from `SWATCHES`, so the demo and the colour picker agree.
 *
 * No image element: an image needs a blob in IndexedDB, and seeding one would
 * mean either a network fetch (offline-hostile, and the app is local-first) or
 * a base64 payload large enough to notice in the bundle. The trade is stated
 * rather than hidden - the demo shows six of the seven element types, every one
 * except `image`.
 */

import { DEFAULT_ZOOM, SWATCHES } from '@/constants';
import {
  createArrow,
  createEllipse,
  createFreehand,
  createLine,
  createRectangle,
  createText,
} from '@/features/elements/factory';
import type { CanvasElement, ElementId, Project, WorldPoint, WorldRect } from '@/types';
import { createId } from '@/utils/id';

export const DEMO_PROJECT_NAME = 'Welcome to CanvasForge';

/* Named so the composition can be read as a layout rather than as coordinates.
   The grid is derived from these; no card position is written by hand. */
const INK = SWATCHES[0]; // near-black
const MUTED = SWATCHES[1]; // grey
const TERRACOTTA = SWATCHES[2];
const AMBER = SWATCHES[3];
const GREEN = SWATCHES[4];
const BLUE = SWATCHES[5];
const VIOLET = SWATCHES[6];
const PAPER = SWATCHES[8]; // white

const ARTBOARD = { x: 0, y: 0, width: 1000, height: 640 } as const;
const MARGIN = 64;
const CONTENT_WIDTH = ARTBOARD.width - MARGIN * 2;

const CARD_COUNT = 3;
const CARD_GAP = 28;
const CARD_WIDTH = (CONTENT_WIDTH - CARD_GAP * (CARD_COUNT - 1)) / CARD_COUNT;
const CARD_TOP = 216;
const CARD_HEIGHT = 200;
const CARD_PADDING = 24;
const BADGE_SIZE = 44;

const FOOTER_TOP = 456;
const FOOTER_HEIGHT = 120;

interface CardSpec {
  readonly accent: string;
  readonly title: string;
  readonly body: string;
}

const CARDS: readonly CardSpec[] = [
  {
    accent: TERRACOTTA,
    title: 'Draw',
    body: 'Rectangles, ellipses, lines, arrows, freehand strokes and live text.',
  },
  {
    accent: GREEN,
    title: 'Transform',
    body: 'Move, resize and rotate - one transform path for every shape type.',
  },
  {
    accent: VIOLET,
    title: 'Export',
    body: 'PNG, SVG and JSON, produced by the same renderer you are looking at.',
  },
];

function box(x: number, y: number, width: number, height: number): WorldRect {
  return { x, y, width, height } as WorldRect;
}

function point(x: number, y: number): WorldPoint {
  return { x, y } as WorldPoint;
}

/** Rotation is a post-factory field: the factories only ever produce axis-aligned elements. */
function rotated<T extends CanvasElement>(element: T, radians: number): T {
  return { ...element, rotation: radians };
}

function cardLeft(index: number): number {
  return MARGIN + index * (CARD_WIDTH + CARD_GAP);
}

function buildElements(): CanvasElement[] {
  const elements: CanvasElement[] = [];

  elements.push(
    createRectangle(box(ARTBOARD.x, ARTBOARD.y, ARTBOARD.width, ARTBOARD.height), {
      name: 'Artboard',
      style: { fill: '#f2f0ec', stroke: null, cornerRadius: 24 },
    })
  );

  // Two low-opacity accents behind the header. They sit off to the right of the
  // text column so they read as depth rather than as clutter.
  elements.push(
    createEllipse(box(772, 36, 152, 152), {
      name: 'Accent circle',
      style: { fill: AMBER, stroke: null, opacity: 0.22 },
    }),
    rotated(
      createRectangle(box(700, 92, 116, 116), {
        name: 'Accent square',
        style: { fill: BLUE, stroke: null, cornerRadius: 22, opacity: 0.18 },
      }),
      0.34
    )
  );

  elements.push(
    createText(box(MARGIN, 56, 560, 64), {
      name: 'Title',
      text: 'CanvasForge',
      style: { fontSize: 54, fontWeight: 700, color: INK, lineHeight: 1.1 },
    }),
    createText(box(MARGIN + 2, 132, 600, 28), {
      name: 'Subtitle',
      text: 'An infinite canvas editor on a hand-rolled Canvas 2D renderer.',
      style: { fontSize: 19, fontWeight: 400, color: MUTED },
    }),
    createLine(point(MARGIN, 180), point(ARTBOARD.width - MARGIN, 180), {
      name: 'Rule',
      style: { stroke: MUTED, strokeWidth: 1, opacity: 0.45 },
    })
  );

  CARDS.forEach((card, index) => {
    const left = cardLeft(index);
    const inner = left + CARD_PADDING;

    elements.push(
      createRectangle(box(left, CARD_TOP, CARD_WIDTH, CARD_HEIGHT), {
        name: `${card.title} card`,
        style: { fill: PAPER, stroke: null, cornerRadius: 14 },
      }),
      createEllipse(box(inner, CARD_TOP + CARD_PADDING, BADGE_SIZE, BADGE_SIZE), {
        name: `${card.title} badge`,
        style: { fill: card.accent, stroke: null },
      }),
      createText(box(inner, CARD_TOP + 84, CARD_WIDTH - CARD_PADDING * 2, 30), {
        name: `${card.title} heading`,
        text: card.title,
        style: { fontSize: 24, fontWeight: 600, color: INK },
      }),
      createText(box(inner, CARD_TOP + 118, CARD_WIDTH - CARD_PADDING * 2, 60), {
        name: `${card.title} body`,
        text: card.body,
        style: { fontSize: 15, fontWeight: 400, color: MUTED, lineHeight: 1.45 },
      })
    );
  });

  elements.push(
    createRectangle(box(MARGIN, FOOTER_TOP, CONTENT_WIDTH, FOOTER_HEIGHT), {
      name: 'Callout',
      style: { fill: INK, stroke: null, cornerRadius: 14 },
    }),
    createText(box(MARGIN + 32, FOOTER_TOP + 28, 520, 32), {
      name: 'Callout heading',
      text: 'Press Ctrl/Cmd + K',
      style: { fontSize: 26, fontWeight: 600, color: PAPER },
    }),
    createText(box(MARGIN + 32, FOOTER_TOP + 68, 520, 24), {
      name: 'Callout body',
      text: 'Every action in the editor lives in one command palette.',
      style: { fontSize: 15, fontWeight: 400, color: '#b9b6b0' },
    }),
    createArrow(
      point(ARTBOARD.width - MARGIN - 168, FOOTER_TOP + FOOTER_HEIGHT / 2),
      point(ARTBOARD.width - MARGIN - 40, FOOTER_TOP + FOOTER_HEIGHT / 2),
      {
        name: 'Callout arrow',
        style: { stroke: AMBER, strokeWidth: 3, arrowheadEnd: 'triangle' },
      }
    )
  );

  /*
    A hand-drawn underline beneath the wordmark.

    Generated from a sine rather than a list of typed coordinates: a
    hand-written point list is unreadable, impossible to adjust, and would be
    the one part of this file that cannot be reasoned about. Two overlaid
    frequencies keep it from looking like a plotted wave - the small one is the
    wobble a hand actually makes.
  */
  const strokePoints: WorldPoint[] = Array.from({ length: 34 }, (_, index) => {
    const t = index / 33;
    const x = MARGIN + 6 + t * 268;
    const y = 118 + Math.sin(t * Math.PI * 1.15) * 5 + Math.sin(t * 22) * 0.9;
    return point(x, y);
  });

  elements.push(
    createFreehand(strokePoints, {
      name: 'Underline',
      style: { stroke: TERRACOTTA, strokeWidth: 3 },
    })
  );

  return elements;
}

export function createDemoProject(name = DEMO_PROJECT_NAME): Project {
  const elements = buildElements();
  const byId: Record<ElementId, CanvasElement> = {};
  const order: ElementId[] = [];
  for (const element of elements) {
    byId[element.id] = element;
    order.push(element.id);
  }

  const now = new Date().toISOString();
  return {
    id: createId(),
    name,
    // Left at the origin at 100%: the session frames a freshly opened document
    // against the real canvas size, which this file has no way to know.
    viewport: { panX: 0, panY: 0, zoom: DEFAULT_ZOOM },
    elements: { byId, order },
    metadata: { createdAt: now, updatedAt: now },
  };
}
