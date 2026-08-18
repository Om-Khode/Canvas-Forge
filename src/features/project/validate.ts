/**
 * Document-level validation of untrusted project documents.
 *
 * Everything that reaches this file is untrusted: an imported `.json` file, a
 * record written by an older build, a row a browser extension mangled. The
 * shape of each individual element is `validateElement`'s problem; this file
 * owns the shape of the *forest* - nesting, depth, and id uniqueness - and the
 * document's own fields.
 *
 * Nesting removes two whole classes of corruption by construction. A flat array
 * of elements plus `childIds` references can dangle (a child id with no
 * element) and can cycle (two groups naming each other); a nested document can
 * express neither, because an element is written where it lives and nowhere
 * else. What nesting adds instead is depth - a file can nest far enough to
 * overflow the stack on any recursive walk, and `MAX_GROUP_DEPTH` is the only
 * thing standing between untrusted input and a crash. That trade is the reason
 * the loader can hand `features/elements/tree.ts` a document at all.
 *
 * The remaining structural invariant is uniqueness: the same id appearing twice
 * anywhere in the forest. Under nesting that single check covers three failures
 * at once - a duplicate at the root, one id claimed by two different parents,
 * and a group that contains itself. All three are "this id is already spoken
 * for", so all three are caught by one `seen` set marked *before* descending.
 */

import { MAX_ZOOM, MIN_ZOOM } from '@/constants/canvas';
import { CURRENT_SCHEMA_VERSION, MAX_GROUP_DEPTH } from '@/constants/storage';
import { err, ok, type Result } from '@/services/result';
import type { SerializedElement, SerializedProject, Viewport } from '@/types';
import { createId } from '@/utils/id';
import {
  asNumber,
  asString,
  clamp,
  isAcceptedDataUri,
  isRecord,
  validateElement,
} from './validateElement';

// Re-exported so `features/project/validate` stays the one import path for
// callers that only ever wanted "validate this untrusted thing".
export { isAcceptedDataUri, validateElement } from './validateElement';

export interface ValidationError {
  readonly kind: 'not-an-object' | 'invalid-shape';
  readonly message: string;
}

export interface ValidationOutcome {
  readonly project: SerializedProject;
  /** Human-readable notes about anything dropped or clamped, for the UI to surface. */
  readonly warnings: readonly string[];
}

/* ----------------------------------------------------------------- forest -- */

interface WalkContext {
  readonly warnings: string[];
  /** Every id already claimed, anywhere in the forest. */
  readonly seen: Set<string>;
}

/**
 * Validates one node and, for a group, everything beneath it.
 *
 * `path` is the node's position as a dotted index chain (`2.0.1`) so a warning
 * about something buried three levels down can still be located in the file.
 * `depth` counts from 1 at the root, matching `tree.ts`'s `maxDepth`.
 */
function validateNode(
  raw: unknown,
  path: string,
  depth: number,
  context: WalkContext
): SerializedElement | null {
  if (depth > MAX_GROUP_DEPTH) {
    context.warnings.push(
      `Dropped element ${path}: nested deeper than the maximum group depth of ${MAX_GROUP_DEPTH}.`
    );
    return null;
  }

  const result = validateElement(raw);
  if (!result.ok) {
    context.warnings.push(`Dropped element ${path}: ${result.error}.`);
    return null;
  }

  const element = result.value;
  if (context.seen.has(element.id)) {
    // A group carries its members inline, so dropping it here drops everything
    // beneath it too - the walk never descends into `children` for a node that
    // doesn't survive this check. Say so; otherwise the warning undercounts
    // what the user actually lost. Root-level paths stay bare indices either
    // way, so the existing `Dropped element 1: …` assertions still hold.
    const subtree = element.type === 'group' ? ' and everything inside it' : '';
    context.warnings.push(`Dropped element ${path}: duplicate id ${element.id}${subtree}.`);
    return null;
  }
  // Claimed before descending, so a group listing itself among its own children
  // loses the inner copy rather than recursing forever.
  context.seen.add(element.id);

  if (element.type !== 'group') return element;

  const rawChildren = isRecord(raw) ? raw.children : undefined;
  // A missing or non-array `children` is a drop, not a clamp: membership is the
  // group's whole identity, and there is nothing sensible to invent for it. An
  // explicit `[]` is different - that is a well-formed statement of "no
  // members", and the store's own empty-group rule decides what to do with it.
  if (!Array.isArray(rawChildren)) {
    context.warnings.push(`Dropped element ${path}: group has no children array.`);
    return null;
  }

  const { childIds: _childIds, ...group } = element;
  const children: SerializedElement[] = [];
  rawChildren.forEach((child: unknown, index) => {
    const node = validateNode(child, `${path}.${index}`, depth + 1, context);
    if (node !== null) children.push(node);
  });
  return { ...group, children };
}

/* --------------------------------------------------------------- project -- */

function validateViewport(value: unknown): Viewport {
  if (!isRecord(value)) return { panX: 0, panY: 0, zoom: 1 };
  return {
    panX: asNumber(value.panX, 0),
    panY: asNumber(value.panY, 0),
    zoom: clamp(asNumber(value.zoom, 1), MIN_ZOOM, MAX_ZOOM),
  };
}

function validateIsoDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return Number.isNaN(Date.parse(value)) ? fallback : value;
}

/**
 * Validates a whole document. Only two things are fatal - the document not
 * being an object, and `elements` not being an array - because in both cases
 * there is no document to salvage. Everything else degrades.
 */
export function validateSerializedProject(
  input: unknown
): Result<ValidationOutcome, ValidationError> {
  if (!isRecord(input)) {
    return err({ kind: 'not-an-object', message: 'This file is not a CanvasForge project.' });
  }
  if (!Array.isArray(input.elements)) {
    return err({ kind: 'invalid-shape', message: 'The project has no elements list.' });
  }

  const context: WalkContext = { warnings: [], seen: new Set<string>() };
  const elements: SerializedElement[] = [];
  input.elements.forEach((raw: unknown, index) => {
    const node = validateNode(raw, String(index), 1, context);
    if (node !== null) elements.push(node);
  });

  const images: Record<string, string> = {};
  if (isRecord(input.images)) {
    for (const [key, value] of Object.entries(input.images)) {
      if (isAcceptedDataUri(value)) {
        images[key] = value;
      } else {
        context.warnings.push(`Dropped image "${key}": not an accepted image data URI.`);
      }
    }
  }

  const now = new Date().toISOString();
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const createdAt = validateIsoDate(metadata.createdAt, now);

  return ok({
    project: {
      schemaVersion: asNumber(input.schemaVersion, CURRENT_SCHEMA_VERSION),
      id: typeof input.id === 'string' && input.id.length > 0 ? input.id : createId(),
      name: asString(input.name, 'Untitled'),
      viewport: validateViewport(input.viewport),
      elements,
      metadata: { createdAt, updatedAt: validateIsoDate(metadata.updatedAt, createdAt) },
      images,
    },
    warnings: context.warnings,
  });
}
