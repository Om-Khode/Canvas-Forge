/**
 * A generated document big enough to make performance claims falsifiable.
 *
 * `docs/architecture.md` §11 asserts that a linear hit-test over culled
 * elements is "fast enough at target scale" and that structural sharing keeps
 * undo memory proportional to the change rather than to the document. Both are
 * plausible. Neither is evidence. This module produces the ~2,000-element
 * document those claims are measured against, and `docs/performance.md` records
 * what the measurements actually said.
 *
 * Three properties matter:
 *
 *  - **Seeded.** Every random draw comes from one `mulberry32` stream, and ids
 *    are derived from the index rather than from `crypto.randomUUID`. Same seed,
 *    byte-identical document - otherwise a regression looks like noise and noise
 *    looks like a regression.
 *  - **Realistic mix.** Six element types, log-distributed sizes, most shapes
 *    axis-aligned with a minority rotated, colours from the editor's own
 *    palette. A field of 2,000 identical rectangles would measure the fast path
 *    of one drawer and tell you nothing about the others.
 *  - **Built through the factories.** `createRectangle` and friends are the same
 *    functions the editor uses, so the stress document cannot drift away from
 *    the element model. Only the id and the rotation are overwritten afterwards,
 *    exactly as `demoProject.ts` does, because the factories deliberately own
 *    neither.
 *
 * Elements are laid out on a jittered grid rather than by uniform random
 * scatter. Uniform scatter clumps - and clumping changes how much of the
 * document a viewport contains, which would make the culling measurement a
 * property of the random seed instead of a property of the engine.
 */

import { SWATCHES } from '@/constants';
import {
  createArrow,
  createEllipse,
  createFreehand,
  createLine,
  createRectangle,
  createText,
} from '@/features/elements/factory';
import type { CanvasElement, ElementId, ElementStore, WorldPoint, WorldRect } from '@/types';

export const DEFAULT_STRESS_COUNT = 2000;

/**
 * Above this the generator is not the problem - a browser tab holding a hundred
 * thousand elements is a different project. The cap exists so a typo in the URL
 * (`?stress=200000`) fails visibly at the parse step instead of hanging the tab.
 */
export const MAX_STRESS_COUNT = 20000;

/** World units. ~4,000 × 2,500 at the default count: a large but plausible board. */
const DEFAULT_CELL = 90;

export interface StressDocumentOptions {
  readonly count?: number;
  readonly seed?: number;
  /** Grid aspect ratio (width ÷ height). Matches a landscape canvas by default. */
  readonly aspect?: number;
}

const DEFAULT_SEED = 0x5f3759df;

/**
 * mulberry32 - 32 bits of state, one multiply-xor-shift round, uniform enough
 * for layout and colour choice and short enough to read in one sitting. Not
 * cryptographic and not trying to be; the requirement is reproducibility, not
 * unpredictability.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Random {
  /** Uniform in [min, max). */
  between(min: number, max: number): number;
  /** Log-uniform in [min, max) - sizes cluster small with a long tail, as real documents do. */
  logBetween(min: number, max: number): number;
  int(maxExclusive: number): number;
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
}

function makeRandom(seed: number): Random {
  const next = mulberry32(seed);
  const between = (min: number, max: number): number => min + next() * (max - min);
  return {
    between,
    logBetween: (min, max) => Math.exp(between(Math.log(min), Math.log(max))),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    // `?? values[0] ?? …` satisfies noUncheckedIndexedAccess without an
    // assertion; the index is always in range for a non-empty list.
    pick: <T>(values: readonly T[]): T => {
      const chosen = values[Math.floor(next() * values.length)] ?? values[0];
      if (chosen === undefined) throw new RangeError('pick: empty list');
      return chosen;
    },
    chance: (probability) => next() < probability,
  };
}

/* ------------------------------------------------------------------- mix -- */

type StressType = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'freehand';

/**
 * Cumulative weights (40% rectangle, 22% ellipse, 12% text, 10% line, 8% arrow,
 * 8% freehand). Rectangles dominate because they do in real documents, and
 * freehand is held under a tenth because a freehand element carries dozens of
 * points and is the one type whose *per-element* cost is unbounded - worth
 * representing, not worth letting it define the average.
 *
 * No `image`: an image element references a blob that would have to exist in
 * IndexedDB, and seeding one would make a pure generator depend on a service.
 * The renderer draws a placeholder for an unresolved key, so including them
 * would measure the placeholder path and call it image rendering.
 */
const TYPE_WEIGHTS: readonly (readonly [StressType, number])[] = [
  ['rectangle', 0.4],
  ['ellipse', 0.62],
  ['text', 0.74],
  ['line', 0.84],
  ['arrow', 0.92],
  ['freehand', 1],
];

const PHRASES: readonly string[] = [
  'Section title',
  'Draft copy for review',
  'Notes',
  'v2 - revised layout',
  'Handoff',
  'Spec',
];

function pickType(random: Random): StressType {
  const roll = random.between(0, 1);
  for (const [type, ceiling] of TYPE_WEIGHTS) {
    if (roll < ceiling) return type;
  }
  return 'rectangle';
}

/* -------------------------------------------------------------- geometry -- */

function box(x: number, y: number, width: number, height: number): WorldRect {
  return { x, y, width, height } as WorldRect;
}

function point(x: number, y: number): WorldPoint {
  return { x, y } as WorldPoint;
}

interface Cell {
  readonly x: number;
  readonly y: number;
}

/**
 * Grid dimensions for `count` cells at the requested aspect ratio. Solved from
 * `columns / rows ≈ aspect` and `columns * rows ≥ count`.
 */
function gridColumns(count: number, aspect: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count * aspect)));
}

/* ------------------------------------------------------------- generator -- */

export function createStressElements(options: StressDocumentOptions = {}): CanvasElement[] {
  const count = Math.max(0, Math.floor(options.count ?? DEFAULT_STRESS_COUNT));
  const random = makeRandom(options.seed ?? DEFAULT_SEED);
  const columns = gridColumns(count, options.aspect ?? 1.6);

  const elements: CanvasElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const cell: Cell = {
      x: (index % columns) * DEFAULT_CELL,
      y: Math.floor(index / columns) * DEFAULT_CELL,
    };
    elements.push(createOne(index, cell, random));
  }
  return elements;
}

export function createStressDocument(options: StressDocumentOptions = {}): ElementStore {
  const elements = createStressElements(options);
  const byId: Record<ElementId, CanvasElement> = {};
  const order: ElementId[] = [];
  for (const element of elements) {
    byId[element.id] = element;
    order.push(element.id);
  }
  return { byId, order };
}

function createOne(index: number, cell: Cell, random: Random): CanvasElement {
  const type = pickType(random);
  // Ids and names are derived from the index so the document is reproducible
  // and so the factories' O(n) "next free name" scan never runs - at 2,000
  // elements that scan alone would be four million regex tests.
  const id = `stress-${index.toString().padStart(5, '0')}`;
  const name = `${type[0]?.toUpperCase() ?? ''}${type.slice(1)} ${index + 1}`;

  // Jitter within the cell, and a size that may overflow it - neighbours
  // overlapping is what a real document looks like and what makes the painter's
  // algorithm do work.
  const x = cell.x + random.between(-DEFAULT_CELL * 0.25, DEFAULT_CELL * 0.25);
  const y = cell.y + random.between(-DEFAULT_CELL * 0.25, DEFAULT_CELL * 0.25);
  const width = random.logBetween(16, 260);
  const height = random.logBetween(16, 200);

  const fill = random.chance(0.75) ? random.pick(SWATCHES) : null;
  const stroke = random.pick(SWATCHES);
  const strokeWidth = random.pick([1, 2, 4] as const);
  const opacity = random.chance(0.8) ? 1 : random.between(0.3, 0.9);

  const element = build(type, { x, y, width, height }, random, {
    name,
    fill,
    stroke,
    strokeWidth,
    opacity,
  });

  // Rotation is applied after construction because the factories only ever
  // produce axis-aligned elements - the same seam `demoProject.ts` uses. Most
  // elements stay unrotated: `rotatedBounds` has a fast path for that, and a
  // document where every shape is tilted would over-report culling cost.
  const rotation = random.chance(0.25) ? random.between(0, Math.PI * 2) : 0;
  return { ...element, id, rotation };
}

interface Paint {
  readonly name: string;
  readonly fill: string | null;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number;
}

function build(
  type: StressType,
  rect: { x: number; y: number; width: number; height: number },
  random: Random,
  paint: Paint
): CanvasElement {
  const { x, y, width, height } = rect;
  const { name, fill, stroke, strokeWidth, opacity } = paint;

  switch (type) {
    case 'rectangle':
      return createRectangle(box(x, y, width, height), {
        name,
        style: { fill, stroke, strokeWidth, opacity, cornerRadius: random.pick([0, 4, 12]) },
      });

    case 'ellipse':
      return createEllipse(box(x, y, width, height), {
        name,
        style: { fill, stroke, strokeWidth, opacity },
      });

    case 'line':
      return createLine(point(x, y), point(x + width, y + height), {
        name,
        style: { stroke, strokeWidth, opacity },
      });

    case 'arrow':
      return createArrow(point(x, y), point(x + width, y + height), {
        name,
        style: { stroke, strokeWidth, opacity, arrowheadEnd: 'triangle' },
      });

    case 'text':
      return createText(box(x, y, Math.max(width, 80), height), {
        name,
        text: random.pick(PHRASES),
        style: {
          color: stroke,
          fontSize: random.pick([12, 14, 20, 32] as const),
          opacity,
        },
      });

    case 'freehand':
      return createFreehand(freehandPoints(x, y, width, height, random), {
        name,
        style: { stroke, strokeWidth, opacity },
      });
  }
}

/**
 * A wobbling stroke across the element's box. 12–40 samples, which is the range
 * a short real pen stroke lands in - long enough that the per-segment hit test
 * and the per-point draw are exercised, short enough that 200 freehand elements
 * are not secretly 200,000 points.
 */
function freehandPoints(
  x: number,
  y: number,
  width: number,
  height: number,
  random: Random
): WorldPoint[] {
  const samples = 12 + random.int(28);
  const points: WorldPoint[] = [];
  for (let i = 0; i < samples; i += 1) {
    const t = i / (samples - 1);
    points.push(
      point(
        x + t * width + random.between(-width * 0.05, width * 0.05),
        y + Math.sin(t * Math.PI * 2) * height * 0.4 + height / 2
      )
    );
  }
  return points;
}

/* ------------------------------------------------------------ url parsing -- */

export const STRESS_PARAM = 'stress';

/**
 * `?stress=2000` → 2000. Anything unparseable, non-positive, or beyond the cap
 * returns `null`, which the caller reads as "no stress document requested".
 *
 * A bare `?stress` (empty value) means "the default size" - the shortest thing
 * to type, and there is no other sensible reading of it.
 */
export function parseStressCount(raw: string | null): number | null {
  if (raw === null) return null;
  if (raw.trim() === '') return DEFAULT_STRESS_COUNT;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_STRESS_COUNT);
}
