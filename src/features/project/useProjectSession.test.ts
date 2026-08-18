/**
 * Framing on load.
 *
 * A stored viewport of exactly (0, 0) means "never framed", and the session
 * answers it by fitting the document. That fit reads the document through a
 * selector, and `ElementStore.order` names root ids only - so it is the same
 * defect as the toolbar's zoom-to-fit, on a path the user hits without
 * clicking anything.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createProjectSession, type ProjectSession } from './useProjectSession';
import { createRectangle } from '@/features/elements/factory';
import { createMemoryBackend } from '@/services/idb';
import { createImageStore, type ImageCodec } from '@/services/imageStore';
import { createProjectRepository, type ProjectRepository } from '@/services/projectRepository';
import { resetCanvasStore, useCanvasStore } from '@/store';
import type { Project } from '@/types';
import { viewportToFit, worldRect } from '@/utils/coords';

const state = () => useCanvasStore.getState();

/** jsdom decodes nothing; the session only needs the store to exist. */
const NO_CODEC: ImageCodec = {
  measure: () => Promise.resolve({ width: 1, height: 1 }),
  resize: () => Promise.resolve(null),
};

let repository: ProjectRepository;
let session: ProjectSession;

beforeEach(() => {
  resetCanvasStore();
  repository = createProjectRepository(createMemoryBackend());
  session = createProjectSession({
    repository,
    images: createImageStore({ backend: createMemoryBackend(), codec: NO_CODEC }),
  });
});

/** A document whose only root is a group, one of whose members is hidden. */
function storeGroupedProject(): Promise<void> {
  const shown = createRectangle(worldRect(0, 0, 200, 200));
  const away = createRectangle(worldRect(2000, 2000, 200, 200));
  state().addElements([shown, away]);
  if (state().group([shown.id, away.id]) === null) throw new Error('grouping failed');
  state().toggleVisible(away.id);

  const project: Project = {
    id: 'grouped',
    name: 'Grouped',
    // (0, 0) is the "never framed" marker the session reacts to.
    viewport: { panX: 0, panY: 0, zoom: 1 },
    elements: state().elements,
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  };
  return repository.saveProject(project).then(() => {
    resetCanvasStore();
  });
}

describe('framing a freshly opened document', () => {
  it('fits on what paints, not on the group boxes in the root order', async () => {
    await storeGroupedProject();
    // Measured before the load, so the fit runs synchronously inside it.
    state().setViewportSize(800, 600);

    const opened = await session.openProject('grouped');
    expect(opened.ok).toBe(true);

    expect(state().elements.order).toHaveLength(1);
    expect(state().viewport).toEqual(
      viewportToFit({ x: 0, y: 0, width: 200, height: 200 }, 800, 600)
    );
  });
});
