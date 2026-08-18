/**
 * A group draws nothing.
 *
 * It exists so the dispatcher stays exhaustive rather than special-casing the
 * one variant with no geometry of its own. Its members are separate entries in
 * paint order and draw themselves; the group contributes only its opacity,
 * which the renderer composes while walking the tree.
 */
export function drawGroup(): void {}
