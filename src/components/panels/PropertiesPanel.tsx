import { useCallback, useRef } from 'react';
import { MousePointerClick } from 'lucide-react';

import { EmptyState, Panel } from '@/components/common';
import { AppearanceSection } from './sections/AppearanceSection';
import { ArrangeSection } from './sections/ArrangeSection';
import { PositionSection } from './sections/PositionSection';
import { TextSection } from './sections/TextSection';
import {
  createArrow,
  createEllipse,
  createFreehand,
  createImage,
  createLine,
  createRectangle,
  createText,
  ELEMENT_TYPE_LABEL,
} from '@/features/elements/factory';
import type { ElementStyle } from '@/features/elements/factory';
import type { ElementPatch } from '@/features/elements/operations';
import {
  ABSENT,
  applicablePatches,
  hasProperty,
  readProperty,
  supportsProperty,
  uniform,
  type ElementPropertyKey,
  type PropertyValue,
} from '@/features/properties/mixed';
import {
  geometryPatches,
  geometrySnapshot,
  type GeometrySnapshot,
} from '@/features/properties/geometry';
import {
  rotationPatches,
  rotationSnapshot,
  type RotationSnapshot,
} from '@/features/properties/rotation';
import { transformTargets } from '@/features/properties/targets';
import { elementsInPaintOrder } from '@/features/elements/tree';
import { transformSet } from '@/features/selection/resolve';
import {
  elementsByIds,
  isStyleableTool,
  useActiveTool,
  useCanvasStore,
  useCanvasStoreShallow,
} from '@/store/index';
import type { CanvasStore, StyleableToolId } from '@/store/index';
import type { CanvasElement, ElementStore } from '@/types';
import { cn } from '@/utils/cn';
import { worldPoint, worldRect } from '@/utils/coords';

export interface PropertiesPanelProps {
  className?: string;
}

/** Stable identity so the shallow comparison sees an unchanged empty selection. */
const NO_ELEMENTS: readonly CanvasElement[] = [];

/**
 * Memoized on `ElementStore` identity, the way `useRenderer`'s
 * `createOrderCache` is. A genuine drag of the selected elements still misses
 * every frame, since the document really is different each one - but every
 * store write that *doesn't* touch `elements` (a pan, a marquee drawn
 * elsewhere, another element's style edit) used to pay for this walk anyway,
 * for as long as the selection sat inside a group.
 */
function createPaintOrderCache(): (document: ElementStore) => readonly CanvasElement[] {
  let lastDocument: ElementStore | null = null;
  let lastResult: readonly CanvasElement[] = [];
  return (document) => {
    if (document !== lastDocument) {
      lastDocument = document;
      lastResult = elementsInPaintOrder(document);
    }
    return lastResult;
  };
}

const cachedPaintOrder = createPaintOrderCache();

/**
 * The selection, in **document order** rather than the order the ids happen to
 * sit in the selection `Set` (which is click order). Align and distribute both
 * consume this list, and a panel whose output depends on which shape you
 * clicked first is a panel that produces different documents from the same
 * visible state.
 */
function selectSelectionInOrder(state: CanvasStore): readonly CanvasElement[] {
  if (state.selection.size === 0) return NO_ELEMENTS;
  const roots = state.elements.order.filter((id) => state.selection.has(id));
  // `order` is root ids only, so a selection made *inside* a group - which is
  // what a double-click produces - is invisible to it and the panel would
  // report nothing selected. The tree walk answers correctly but costs the
  // whole document, so it is only reached when the cheap filter came up short,
  // and cached against the document so it is paid once per document change
  // rather than once per store write while such a selection persists.
  if (roots.length === state.selection.size) return elementsByIds(state.elements, roots);
  return cachedPaintOrder(state.elements).filter((element) => state.selection.has(element.id));
}

/**
 * The elements a *style* edit lands on.
 *
 * Position and size read the selection itself, so a group shows the one derived
 * box the user is looking at. Fill, stroke and text have no such box: a group
 * carries none of those properties, so reading the selection would render no
 * controls at all and writing to it would patch a property the group does not
 * have. Expanding to leaves makes "select a group, change the fill" mean what
 * it looks like it means.
 *
 * Not filtered by lock, deliberately - `gestureTargets` is the pointer path's
 * rule. Restyling a locked element from the panel is how you work with one.
 */
function selectStyleTargets(state: CanvasStore): readonly CanvasElement[] {
  if (state.selection.size === 0) return NO_ELEMENTS;
  return transformSet(state.elements, state.selection);
}

/**
 * The elements a *transform* edit - position, size or angle - can actually land
 * on: a group contributes its unlocked leaves, because not one of the five
 * numbers on a group is a number anything writes. `features/properties/targets`
 * owns that rule and the reason.
 *
 * Read for one purpose: deciding whether the Transform controls have a target at
 * all. What they *display* is the selection itself, so a group shows the derived
 * box the user is looking at rather than a union of its members' separate boxes.
 */
function selectTransformTargets(state: CanvasStore): readonly CanvasElement[] {
  if (state.selection.size === 0) return NO_ELEMENTS;
  return transformTargets(state.elements, state.selection);
}

/**
 * The state a position or size gesture is replayed against, taken at the moment
 * it begins. One helper for both entry points - the single `onChange` of a typed
 * value and the `onScrubStart` of a drag - because "same capture, same replay" is
 * the only reason those two agree, and the lock is easy to freeze in one of them
 * and read live in the other.
 */
function takeGeometrySnapshot(state: CanvasStore): GeometrySnapshot {
  return geometrySnapshot(state.elements, state.selection, { lockAspect: state.lockAspect });
}

function selectionLabel(elements: readonly CanvasElement[]): string {
  const first = elements[0];
  if (elements.length === 1 && first !== undefined) return ELEMENT_TYPE_LABEL[first.type];
  return `${elements.length} elements selected`;
}

/**
 * Contextual property editor for the current selection.
 *
 * Two things here are load-bearing rather than incidental.
 *
 * **The write callbacks never close over the selection.** They read it back out
 * of the store at call time, which makes them referentially stable for the life
 * of the panel. During a canvas drag this component re-renders every frame -
 * that is expected, the numbers on screen are changing - and stable handlers are
 * what keep that re-render confined to the fields whose values moved instead of
 * rebuilding the whole subtree's props.
 *
 * **Every write is narrowed to the elements that can accept it.** For a style
 * edit that is `applicablePatches`: setting a fill on a selection of rectangles
 * and lines must patch the rectangles only, because writing `fill` onto a
 * `LineElement` produces an element that fails validation on save. For a
 * transform edit the narrowing is structural instead - a group holds no geometry
 * of its own, so the write is redirected to its leaves by
 * `features/properties/geometry` and `…/rotation`, which is what lets a group
 * accept every field in the Transform section without any of them landing on the
 * derived cache that would erase them.
 */
export function PropertiesPanel({ className }: PropertiesPanelProps) {
  const elements = useCanvasStoreShallow(selectSelectionInOrder);
  const styleTargets = useCanvasStoreShallow(selectStyleTargets);
  const transformFields = useCanvasStoreShallow(selectTransformTargets);
  /**
   * One flag for all five Transform controls, because they now share a target.
   * Empty only for a selection whose every member is a locked leaf of a group -
   * which still *shows* its derived box and its leaves' angle, since information
   * the user can see on the canvas is worth reading even when it cannot be
   * edited.
   */
  const transformDisabled = transformFields.length === 0;
  /**
   * Store state, not panel state: the canvas resize handles read the same flag
   * and OR it with Shift. A toggle that only coupled the W/H fields here would
   * be a control that appears to do one thing and does half of it.
   */
  const lockAspect = useCanvasStore((state) => state.lockAspect);
  const setLockAspect = useCanvasStore((state) => state.setLockAspect);

  /**
   * The state an in-flight scrub replays against - the panel's counterpart to
   * the pointer path's `GestureSnapshot`, one per gesture the Transform section
   * can start. Refs, not state: a scrub emits an `onChange` per pointermove, and
   * the origin of the gesture must not be recreated by a render in the middle of
   * it.
   */
  const geometryScrub = useRef<GeometrySnapshot | null>(null);
  const rotationScrub = useRef<RotationSnapshot | null>(null);

  /**
   * The write half of the Position and Size fields. What X or W *mean* for a
   * group is decided in `features/properties/geometry`: its box is a derived
   * cache, so the edit is baked into the leaves - the same thing the canvas does
   * when the group's frame is dragged or a handle pulled. The aspect lock is
   * decided there too, from the flag as it stood when the gesture began, so the
   * W and H fields send one axis and nothing here has to know about the other.
   */
  const change = useCallback((patch: ElementPatch, label: string): void => {
    const state = useCanvasStore.getState();
    const taken = geometryScrub.current ?? takeGeometrySnapshot(state);
    state.applyPatches(geometryPatches(taken, patch), label);
  }, []);

  /**
   * The write half of the angle field. What an angle *means* for a group is
   * decided in `features/properties/rotation`, including why a scrub replays the
   * snapshot frozen at pointerdown while a typed value takes one now.
   */
  const rotate = useCallback((radians: number): void => {
    const state = useCanvasStore.getState();
    const taken = rotationScrub.current ?? rotationSnapshot(state.elements, state.selection);
    state.applyPatches(rotationPatches(taken, radians), 'Rotate');
  }, []);

  /** The write half of `selectStyleTargets`; see the note there. */
  const changeStyle = useCallback((patch: ElementPatch, label: string): void => {
    const state = useCanvasStore.getState();
    const targets = transformSet(state.elements, state.selection);
    state.applyPatches(applicablePatches(targets, patch), label);
  }, []);

  /**
   * Scrubbing a NumberField emits an onChange per pointermove. Bracketing the
   * gesture in one transaction is what makes it a single undo entry rather than
   * one per frame - the same rule the canvas drag path follows.
   */
  const beginScrub = useCallback((label: string): void => {
    useCanvasStore.getState().beginTransaction(label);
  }, []);

  /** As above, plus the state a position or size scrub is replayed against. */
  const beginGeometryScrub = useCallback((label: string): void => {
    const state = useCanvasStore.getState();
    state.beginTransaction(label);
    geometryScrub.current = takeGeometrySnapshot(state);
  }, []);

  /** As above, plus the state the whole gesture is replayed against. */
  const beginRotateScrub = useCallback((): void => {
    const state = useCanvasStore.getState();
    state.beginTransaction('Rotate');
    rotationScrub.current = rotationSnapshot(state.elements, state.selection);
  }, []);

  const endScrub = useCallback((): void => {
    // Every scrub ends through here - including one torn down by unmount, which
    // `NumberField`'s cleanup routes here too - and a snapshot left behind would
    // silently become the origin of the *next* typed value.
    geometryScrub.current = null;
    rotationScrub.current = null;
    useCanvasStore.getState().commitTransaction();
  }, []);

  return (
    <Panel as="aside" title="Properties" className={cn('w-64', className)}>
      {elements.length === 0 ? (
        <ToolDefaults />
      ) : (
        <>
          <p className="text-ink-muted border-edge border-b px-3 py-2 text-[0.75rem]">
            {selectionLabel(elements)}
          </p>

          <PositionSection
            x={readProperty(elements, 'x')}
            y={readProperty(elements, 'y')}
            width={readProperty(elements, 'width')}
            height={readProperty(elements, 'height')}
            rotation={readProperty(transformDisabled ? styleTargets : transformFields, 'rotation')}
            lockAspect={lockAspect}
            onLockAspectChange={setLockAspect}
            onChange={change}
            onRotate={rotate}
            onScrubStart={beginGeometryScrub}
            onRotateScrubStart={beginRotateScrub}
            onScrubEnd={endScrub}
            disabled={transformDisabled}
          />

          <AppearanceSection
            fill={readProperty(styleTargets, 'fill')}
            stroke={readProperty(styleTargets, 'stroke')}
            strokeWidth={readProperty(styleTargets, 'strokeWidth')}
            strokeStyle={readProperty(styleTargets, 'strokeStyle')}
            opacity={readProperty(styleTargets, 'opacity')}
            cornerRadius={readProperty(styleTargets, 'cornerRadius')}
            onChange={changeStyle}
            onScrubStart={beginScrub}
            onScrubEnd={endScrub}
          />

          {supportsProperty(styleTargets, 'fontSize') && (
            <TextSection
              fontFamily={readProperty(styleTargets, 'fontFamily')}
              fontSize={readProperty(styleTargets, 'fontSize')}
              fontWeight={readProperty(styleTargets, 'fontWeight')}
              italic={readProperty(styleTargets, 'italic')}
              textAlign={readProperty(styleTargets, 'textAlign')}
              lineHeight={readProperty(styleTargets, 'lineHeight')}
              color={readProperty(styleTargets, 'color')}
              onChange={changeStyle}
              onScrubStart={beginScrub}
              onScrubEnd={endScrub}
            />
          )}

          <ArrangeSection elements={elements} />
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- defaults -- */

/**
 * One throwaway element per drawing tool, built once at module load.
 *
 * The tool defaults panel has to answer "does this tool's output have a fill?",
 * and the honest answer is "ask an element of the kind it makes". A hand-written
 * table of tool → properties would be a second description of the element model
 * that drifts the first time a variant gains a property; a prototype cannot
 * drift, because the factories are the model.
 */
const TOOL_PROTOTYPE: Readonly<Record<StyleableToolId, CanvasElement>> = {
  rectangle: createRectangle(worldRect(0, 0, 1, 1)),
  ellipse: createEllipse(worldRect(0, 0, 1, 1)),
  line: createLine(worldPoint(0, 0), worldPoint(1, 1)),
  arrow: createArrow(worldPoint(0, 0), worldPoint(1, 1)),
  freehand: createFreehand([worldPoint(0, 0), worldPoint(1, 1)]),
  text: createText(worldRect(0, 0, 1, 1)),
  image: createImage(worldRect(0, 0, 1, 1), { imageKey: '', naturalWidth: 1, naturalHeight: 1 }),
};

function styleProperty<K extends ElementPropertyKey & keyof ElementStyle>(
  prototype: CanvasElement,
  style: ElementStyle,
  key: K
): PropertyValue<ElementStyle[K]> {
  return hasProperty(prototype, key) ? uniform(style[key]) : ABSENT;
}

/**
 * With nothing selected the panel edits the *active tool's* default style, so a
 * user can choose a fill and then draw, rather than drawing and then fixing it.
 * The store already keeps one style per tool for exactly this.
 *
 * Style defaults are not part of the document, so these writes never enter
 * history - which is why they use `setDefaultStyle` directly and ignore the
 * history label the sections pass.
 */
function ToolDefaults() {
  const tool = useActiveTool();
  const styleable = isStyleableTool(tool) ? tool : null;
  const style = useCanvasStore((state) =>
    styleable === null ? null : state.defaultStyles[styleable]
  );

  const change = useCallback(
    (patch: ElementPatch, _label: string): void => {
      if (styleable === null) return;
      useCanvasStore.getState().setDefaultStyle(styleable, patch);
    },
    [styleable]
  );

  const noop = useCallback((): void => {
    /* Tool defaults are not in history, so a scrub has nothing to bracket. */
  }, []);

  const prototype = styleable === null ? null : TOOL_PROTOTYPE[styleable];

  return (
    <>
      <EmptyState
        icon={MousePointerClick}
        title="Nothing selected"
        description={
          styleable === null
            ? 'Select an element on the canvas to edit its properties.'
            : 'Select an element to edit it, or set the defaults below before you draw.'
        }
      />

      {prototype !== null && style !== null && (
        <>
          <AppearanceSection
            fill={styleProperty(prototype, style, 'fill')}
            stroke={styleProperty(prototype, style, 'stroke')}
            strokeWidth={styleProperty(prototype, style, 'strokeWidth')}
            strokeStyle={styleProperty(prototype, style, 'strokeStyle')}
            opacity={styleProperty(prototype, style, 'opacity')}
            cornerRadius={styleProperty(prototype, style, 'cornerRadius')}
            onChange={change}
            onScrubStart={noop}
            onScrubEnd={noop}
          />

          {hasProperty(prototype, 'fontSize') && (
            <TextSection
              fontFamily={styleProperty(prototype, style, 'fontFamily')}
              fontSize={styleProperty(prototype, style, 'fontSize')}
              fontWeight={styleProperty(prototype, style, 'fontWeight')}
              italic={styleProperty(prototype, style, 'italic')}
              textAlign={styleProperty(prototype, style, 'textAlign')}
              lineHeight={styleProperty(prototype, style, 'lineHeight')}
              color={styleProperty(prototype, style, 'color')}
              onChange={change}
              onScrubStart={noop}
              onScrubEnd={noop}
            />
          )}
        </>
      )}
    </>
  );
}
