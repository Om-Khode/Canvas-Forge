/**
 * Element-level validation: one untrusted record in, one `CanvasElement` out.
 *
 * Split from `validate.ts` because the two levels defend against different
 * things. This file knows the *shape* of every union variant - which fields are
 * identity and must be present, which are values and can be clamped. Its
 * sibling knows the *structure* of a document: nesting, depth, id uniqueness.
 * Neither needs the other's knowledge, and together they exceeded the module
 * size this codebase holds itself to.
 *
 * Two rules shape everything below.
 *
 * **Drop, don't abort.** A document with one bad element loads with that
 * element removed and reported. Rejecting the whole file would cost a user
 * their project because of one broken shape - the wrong trade every time.
 *
 * **Clamp, don't reject.** An opacity of `4`, a negative width, or an `x` of
 * `NaN` are all recoverable: the intent is obvious and a clamped value renders.
 * Only fields that carry *identity* (`id`, `type`, `imageKey`) cause a drop,
 * because there is nothing sensible to invent for them.
 *
 * Hand-written type guards rather than zod/valibot: the schema is one union of
 * eight variants, the guards are the interesting part (the clamping rules and
 * the data-URI check below are policy, not shape), and a runtime schema library
 * would be ~15KB to express something the compiler already describes.
 *
 * The data-URI check is a security boundary, not a nicety. A project file is
 * attacker-supplyable and its image fields go straight into `<image href>` in
 * SVG export and into an `Image.src`. Allowing an arbitrary URI there admits
 * `javascript:`, remote-tracking `https:` beacons, and `data:text/html`.
 */

import {
  ACCEPTED_IMAGE_TYPES,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TEXT_COLOR,
} from '@/constants/defaults';
import { err, ok, type Result } from '@/services/result';
import type {
  ArrowheadStyle,
  CanvasElement,
  ElementType,
  FontWeight,
  StrokeStyle,
  TextAlign,
  Vec2,
} from '@/types';

type Rec = Record<string, unknown>;

/**
 * The runtime allow-list. Kept separate from the `ElementType` union because
 * this one answers "may a *file* say this?", which is a narrower question than
 * "does the app model this?" - a variant can exist in the model before the
 * reader understands it on disk.
 */
const ELEMENT_TYPES: readonly ElementType[] = [
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'text',
  'image',
  'freehand',
  'group',
];
const STROKE_STYLES: readonly StrokeStyle[] = ['solid', 'dashed', 'dotted'];
const ARROWHEADS: readonly ArrowheadStyle[] = ['none', 'triangle', 'line'];
const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];
const FONT_WEIGHTS: readonly FontWeight[] = [400, 500, 600, 700];

/* ------------------------------------------------------------- coercion -- */

export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asEnum<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function asVec2(value: unknown, fallback: Vec2): Vec2 {
  if (!isRecord(value)) return fallback;
  return { x: asNumber(value.x, fallback.x), y: asNumber(value.y, fallback.y) };
}

/**
 * Colours end up in `ctx.fillStyle` and in SVG paint attributes. A permissive
 * pattern rather than a full CSS colour parser: hex, functional notation, or a
 * bare identifier (named colours, `transparent`, `currentColor`). It rejects
 * `url(...)` paint-server references, which in SVG can point off-origin.
 */
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9.,%\s/-]+\)|[a-z]+)$/i;

function asColor(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  return COLOR_PATTERN.test(value.trim()) ? value.trim() : fallback;
}

/** `data:<mime>[;param][;base64],<payload>` - the mime must be one we accept. */
const DATA_URI_PATTERN = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)[a-z0-9;=+/-]*,/i;

export function isAcceptedDataUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATA_URI_PATTERN.exec(value);
  if (!match?.[1]) return false;
  const mime = match[1].toLowerCase();
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mime);
}

/* -------------------------------------------------------------- elements -- */

interface BaseFields {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  locked: boolean;
  visible: boolean;
}

function baseFields(rec: Rec, type: ElementType): Result<BaseFields, string> {
  const id = rec.id;
  if (typeof id !== 'string' || id.length === 0) {
    return err('element has no id');
  }
  return ok({
    id,
    name: asString(rec.name, type),
    x: asNumber(rec.x, 0),
    y: asNumber(rec.y, 0),
    // Clamped at 0, not at MIN_ELEMENT_SIZE: a horizontal line's bounding box
    // legitimately has zero height, and forcing a minimum would reshape it.
    width: Math.max(0, asNumber(rec.width, 0)),
    height: Math.max(0, asNumber(rec.height, 0)),
    rotation: asNumber(rec.rotation, 0),
    opacity: clamp(asNumber(rec.opacity, 1), 0, 1),
    locked: asBool(rec.locked, false),
    visible: asBool(rec.visible, true),
  });
}

function strokeFields(rec: Rec): {
  stroke: string | null;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
} {
  return {
    stroke: asColor(rec.stroke, null),
    strokeWidth: Math.max(0, asNumber(rec.strokeWidth, DEFAULT_STROKE_WIDTH)),
    strokeStyle: asEnum(rec.strokeStyle, STROKE_STYLES, 'solid'),
  };
}

function isKnownElementType(value: unknown): value is ElementType {
  return typeof value === 'string' && (ELEMENT_TYPES as readonly string[]).includes(value);
}

/**
 * Validates one element in isolation. `err` means "drop this and tell the user
 * why".
 *
 * Deliberately flat: a group's members are *not* read here. On disk they are
 * nested children the document walker resolves, and in a clipboard payload they
 * are a flat `childIds` list - two different shapes that only their respective
 * readers can interpret. This function produces a group with the `childIds` it
 * can see and lets the caller correct it, which keeps one element validator
 * serving both callers instead of two half-validators.
 */
export function validateElement(input: unknown): Result<CanvasElement, string> {
  if (!isRecord(input)) return err('element is not an object');

  const rawType = input.type;
  if (!isKnownElementType(rawType)) {
    return err(`unknown element type ${JSON.stringify(rawType)}`);
  }
  const type = rawType;

  const base = baseFields(input, type);
  if (!base.ok) return base;
  const b = base.value;

  switch (type) {
    case 'rectangle':
      return ok({
        ...b,
        type,
        ...strokeFields(input),
        fill: asColor(input.fill, null),
        cornerRadius: Math.max(0, asNumber(input.cornerRadius, 0)),
      });

    case 'ellipse':
      return ok({ ...b, type, ...strokeFields(input), fill: asColor(input.fill, null) });

    case 'line':
      return ok({
        ...b,
        type,
        ...strokeFields(input),
        start: asVec2(input.start, { x: 0, y: 0 }),
        end: asVec2(input.end, { x: 1, y: 1 }),
      });

    case 'arrow':
      return ok({
        ...b,
        type,
        ...strokeFields(input),
        start: asVec2(input.start, { x: 0, y: 0 }),
        end: asVec2(input.end, { x: 1, y: 1 }),
        arrowheadStart: asEnum(input.arrowheadStart, ARROWHEADS, 'none'),
        arrowheadEnd: asEnum(input.arrowheadEnd, ARROWHEADS, 'triangle'),
      });

    case 'text':
      return ok({
        ...b,
        type,
        text: asString(input.text, ''),
        fontFamily: asString(input.fontFamily, DEFAULT_FONT_FAMILY),
        fontSize: clamp(asNumber(input.fontSize, DEFAULT_FONT_SIZE), 1, 1000),
        fontWeight: asEnum(input.fontWeight, FONT_WEIGHTS, DEFAULT_FONT_WEIGHT),
        italic: asBool(input.italic, false),
        textAlign: asEnum(input.textAlign, TEXT_ALIGNS, 'left'),
        lineHeight: clamp(asNumber(input.lineHeight, DEFAULT_LINE_HEIGHT), 0.5, 10),
        color: asColor(input.color, DEFAULT_TEXT_COLOR) ?? DEFAULT_TEXT_COLOR,
        autoHeight: asBool(input.autoHeight, true),
      });

    case 'image': {
      const imageKey = input.imageKey;
      // No key means no pixels can ever be found: unrenderable, so drop it
      // rather than leaving a permanent placeholder in the document.
      if (typeof imageKey !== 'string' || imageKey.length === 0)
        return err('image element has no key');
      return ok({
        ...b,
        type,
        imageKey,
        naturalWidth: Math.max(1, asNumber(input.naturalWidth, Math.max(1, b.width))),
        naturalHeight: Math.max(1, asNumber(input.naturalHeight, Math.max(1, b.height))),
        alt: asString(input.alt, ''),
      });
    }

    case 'freehand': {
      const raw = input.points;
      if (!Array.isArray(raw)) return err('freehand element has no points array');
      const points: Vec2[] = raw.filter(isRecord).map((point) => asVec2(point, { x: 0, y: 0 }));
      if (points.length === 0) return err('freehand element has no usable points');
      return ok({ ...b, type, ...strokeFields(input), points });
    }

    case 'group': {
      const raw = input.childIds;
      // Non-string entries are filtered rather than fatal: an id that is not a
      // string could never match an element anyway, and dropping the group over
      // one bad entry would orphan members that are perfectly valid.
      const childIds: readonly string[] = Array.isArray(raw)
        ? raw.filter((id: unknown): id is string => typeof id === 'string')
        : [];
      return ok({ ...b, type, childIds });
    }
  }
}
