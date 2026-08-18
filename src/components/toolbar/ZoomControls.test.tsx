import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ZoomControls } from './ZoomControls';
import { createRectangle } from '@/features/elements/factory';
import { resetCanvasStore, useCanvasStore } from '@/store';
import { viewportToFit, worldRect } from '@/utils/coords';

/**
 * Zoom-to-fit reads the document through a selector, and `ElementStore.order`
 * names root ids only. These go through the real store rather than a literal,
 * because a hand-built store with the members in `order` is precisely the shape
 * that hid this defect from the rest of the suite.
 */

const state = () => useCanvasStore.getState();

beforeEach(() => {
  resetCanvasStore();
});

function clickFit(): void {
  render(<ZoomControls />);
  fireEvent.click(screen.getByRole('button', { name: 'Zoom to fit' }));
}

describe('zoom to fit', () => {
  it('frames a document whose content is entirely inside a group', () => {
    const a = createRectangle(worldRect(0, 0, 100, 100));
    const b = createRectangle(worldRect(100, 100, 100, 100));
    state().addElements([a, b]);
    if (state().group([a.id, b.id]) === null) throw new Error('grouping failed');
    state().setViewportSize(800, 600);

    clickFit();

    expect(state().viewport).toEqual(
      viewportToFit({ x: 0, y: 0, width: 200, height: 200 }, 800, 600)
    );
  });

  it('ignores a hidden member, which the group’s cached box still spans', () => {
    const shown = createRectangle(worldRect(0, 0, 200, 200));
    const away = createRectangle(worldRect(2000, 2000, 200, 200));
    state().addElements([shown, away]);
    if (state().group([shown.id, away.id]) === null) throw new Error('grouping failed');
    state().toggleVisible(away.id);
    state().setViewportSize(800, 600);

    clickFit();

    // Measuring the container would reserve room for 2,200 units of nothing.
    expect(state().viewport).toEqual(
      viewportToFit({ x: 0, y: 0, width: 200, height: 200 }, 800, 600)
    );
  });

  it('degrades to a reset when every member of the only group is hidden', () => {
    const a = createRectangle(worldRect(500, 500, 100, 100));
    const b = createRectangle(worldRect(700, 700, 100, 100));
    state().addElements([a, b]);
    const groupId = state().group([a.id, b.id]);
    if (groupId === null) throw new Error('grouping failed');
    state().toggleVisible(groupId);
    state().setViewportSize(800, 600);

    clickFit();

    // Nothing paints, so there is nothing to frame - the group's box is not a
    // stand-in for content that is not there.
    expect(state().viewport.panX).toBe(400);
    expect(state().viewport.panY).toBe(300);
    expect(state().viewport.zoom).toBe(1);
  });
});
