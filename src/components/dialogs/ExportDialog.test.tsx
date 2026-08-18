import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ExportDialog } from './ExportDialog';
import { setExportFormat } from '@/features/commands';
import { createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store';
import { worldRect } from '@/utils/coords';

/**
 * The dialog's own wiring, not the serializers'. What it has to get right is
 * *which* elements it hands over: `ElementStore.order` names root ids only, so
 * the walk this used to do reported a grouped document as one element - a
 * group - and both raster exports came out empty.
 *
 * The JSON estimate is the cheapest honest read of that decision: it is the
 * element count, rendered as text, straight from the array the export uses.
 */

const state = () => useCanvasStore.getState();

beforeEach(() => {
  resetCanvasStore();
  setExportFormat('json');
});

describe('what the dialog exports', () => {
  it('counts the members of a group, not just the group', () => {
    const a = createRectangle(worldRect(0, 0, 100, 100));
    const b = createRectangle(worldRect(200, 200, 100, 100));
    state().addElements([a, b]);
    if (state().group([a.id, b.id]) === null) throw new Error('grouping failed');
    state().openDialog('export');

    render(<ExportDialog />);

    // The premise: one root, so the old walk found one element.
    expect(state().elements.order).toHaveLength(1);
    // The group plus its two members.
    expect(screen.getByText('3 elements')).toBeInTheDocument();
  });

  it('reports nothing to export when the only group is hidden', () => {
    const a = createRectangle(worldRect(0, 0, 100, 100));
    const b = createRectangle(worldRect(200, 200, 100, 100));
    state().addElements([a, b]);
    const groupId = state().group([a.id, b.id]);
    if (groupId === null) throw new Error('grouping failed');
    state().toggleVisible(groupId);
    state().openDialog('export');

    render(<ExportDialog />);

    // `visible` is still true on both members - the ancestor is what decides,
    // and a walk that dropped only the group would have re-admitted them.
    expect(state().elements.byId[a.id]?.visible).toBe(true);
    expect(screen.getByText('Nothing to export')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('disables the button for a visible group whose members are all hidden', () => {
    const a = createRectangle(worldRect(0, 0, 100, 100));
    const b = createRectangle(worldRect(200, 200, 100, 100));
    state().addElements([a, b]);
    const groupId = state().group([a.id, b.id]);
    if (groupId === null) throw new Error('grouping failed');
    state().toggleVisible(a.id);
    state().toggleVisible(b.id);
    state().openDialog('export');
    setExportFormat('png');

    render(<ExportDialog />);

    // The group itself is still visible, so `elements = [group]` - a bare
    // length check would have left the button enabled here, exactly the input
    // `planPngExportFor` returns `null` for.
    expect(state().elements.byId[groupId]?.visible).toBe(true);
    expect(screen.getByText('Nothing to export')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('still lets the same document export as JSON, since serializing needs nothing to paint', () => {
    const a = createRectangle(worldRect(0, 0, 100, 100));
    const b = createRectangle(worldRect(200, 200, 100, 100));
    state().addElements([a, b]);
    const groupId = state().group([a.id, b.id]);
    if (groupId === null) throw new Error('grouping failed');
    state().toggleVisible(a.id);
    state().toggleVisible(b.id);
    state().openDialog('export');
    setExportFormat('json');

    render(<ExportDialog />);

    expect(screen.getByText('1 element')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).not.toBeDisabled();
  });
});
