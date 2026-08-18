/**
 * The DOM side of the canvas. Everything that actually paints lives in
 * `features/canvas/engine`, which knows nothing about React; these modules are
 * the wiring that connects it to a mounted element, a store, and a pointer -
 * plus the one piece of chrome a canvas genuinely cannot draw, a text caret.
 */

export { CanvasStage, type CanvasStageProps } from './CanvasStage';
export { TextEditorOverlay } from './TextEditorOverlay';
export { useCanvasSize, type CanvasSize } from './useCanvasSize';
export { useRenderer } from './useRenderer';
export {
  autoHeightFor,
  textEditorBox,
  textMeasurer,
  useTextEditing,
  type FontMeasurer,
  type TextEditorBox,
  type TextEditSession,
} from './useTextEditing';
