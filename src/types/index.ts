export type {
  ScreenPoint,
  WorldPoint,
  WorldVector,
  Vec2,
  Rect,
  WorldRect,
  ScreenRect,
  Matrix2D,
  ResizeHandle,
  TransformHandle,
} from './geometry';

export type {
  ElementId,
  ElementType,
  StrokeStyle,
  ArrowheadStyle,
  TextAlign,
  FontWeight,
  BaseElement,
  StrokeProps,
  FillProps,
  RectangleElement,
  EllipseElement,
  LineElement,
  ArrowElement,
  TextElement,
  ImageElement,
  FreehandElement,
  GroupElement,
  CanvasElement,
  FillableElement,
  StrokableElement,
  LinearElement,
} from './element';

export { assertNever } from './element';

export type {
  Viewport,
  ElementStore,
  ProjectMetadata,
  Project,
  SerializedElement,
  SerializedGroupElement,
  SerializedProject,
  ProjectSummary,
  SaveStatus,
} from './project';

export type { ToolId, DrawingToolId, InteractionState, InteractionPreview } from './tools';
