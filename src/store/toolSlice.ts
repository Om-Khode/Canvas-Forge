/**
 * Active tool, pointer state machine, and the style new elements inherit.
 *
 * The interaction state is stored as the `InteractionState` discriminated union
 * from `types/tools.ts` rather than a handful of booleans, so "dragging and
 * resizing at the same time" is unrepresentable and each state carries exactly
 * the data that state needs.
 *
 * Note what is *not* here: the in-flight drag delta, the marquee rectangle, the
 * draft shape. Those are transient interaction data, they change on every
 * pointermove, and putting them in the store would push React work into a path
 * that is supposed to touch only the renderer.
 */

import { DEFAULT_ELEMENT_STYLE } from '@/features/elements/factory';
import type { ElementStyle } from '@/features/elements/factory';
import type { CanvasStore } from '@/store/index';
import type { InteractionState, ToolId } from '@/types';
import type { StateCreator } from 'zustand';

/** Tools that create something and therefore have a style. Not `select`/`hand`. */
export type StyleableToolId = Exclude<ToolId, 'select' | 'hand'>;

const STYLEABLE_TOOLS: readonly StyleableToolId[] = [
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'freehand',
  'text',
  'image',
];

export interface ToolSlice {
  readonly tool: ToolId;
  readonly interaction: InteractionState;
  /**
   * Per-tool, not global: setting a red fill while drawing rectangles should
   * not repaint the next arrow's stroke. Each tool remembers what it was last
   * used with, which is the behaviour that stops feeling surprising after about
   * the third shape.
   */
  readonly defaultStyles: Readonly<Record<StyleableToolId, ElementStyle>>;

  setTool: (tool: ToolId) => void;
  setInteraction: (interaction: InteractionState) => void;
  setDefaultStyle: (tool: StyleableToolId, patch: Partial<ElementStyle>) => void;
}

export const IDLE_INTERACTION: InteractionState = { kind: 'idle' };

function initialStyles(): Record<StyleableToolId, ElementStyle> {
  const styles = {} as Record<StyleableToolId, ElementStyle>;
  for (const tool of STYLEABLE_TOOLS) {
    styles[tool] = DEFAULT_ELEMENT_STYLE;
  }
  return styles;
}

export const createToolSlice: StateCreator<CanvasStore, [], [], ToolSlice> = (set, get) => ({
  tool: 'select',
  interaction: IDLE_INTERACTION,
  defaultStyles: initialStyles(),

  setTool: (tool) => {
    const state = get();
    if (state.tool === tool) return;
    // Switching tools mid-gesture would leave the old state machine's move/up
    // handlers waiting for an event that now means something else.
    set({ tool, interaction: IDLE_INTERACTION });
  },

  setInteraction: (interaction) => {
    set({ interaction });
  },

  setDefaultStyle: (tool, patch) => {
    const current = get().defaultStyles;
    set({ defaultStyles: { ...current, [tool]: { ...current[tool], ...patch } } });
  },
});

/* -------------------------------------------------------------- selectors -- */

export function isStyleableTool(tool: ToolId): tool is StyleableToolId {
  return tool !== 'select' && tool !== 'hand';
}

/** The style a new element should inherit, given the tool that is drawing it. */
export function selectActiveStyle(state: CanvasStore): ElementStyle {
  return isStyleableTool(state.tool)
    ? state.defaultStyles[state.tool]
    : state.defaultStyles.rectangle;
}

export function selectIsIdle(state: CanvasStore): boolean {
  return state.interaction.kind === 'idle';
}
