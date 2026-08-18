/**
 * The panels the editor shell mounts around the canvas.
 *
 * Only the panels and the sheet that presents them on narrow viewports are
 * exported. Their sections, the row component, the reorder hook and the
 * minimap's engine binding are implementation details of these - exporting them
 * would invite a second consumer and turn an internal layout decision into an
 * API.
 */

export { PropertiesPanel, type PropertiesPanelProps } from './PropertiesPanel';
export { LayersPanel, type LayersPanelProps } from './LayersPanel';
export { Minimap, type MinimapProps } from './Minimap';
export { PanelSheet, type PanelSheetProps } from './PanelSheet';
