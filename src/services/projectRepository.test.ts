import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, STORE_IMAGES, STORE_PROJECTS } from '@/constants/storage';
import { createGroup } from '@/features/elements/group';
import type { CanvasElement, Project } from '@/types';
import { createMemoryBackend, type StorageBackend } from './idb';
import { createProjectRepository, emptyProject, type ProjectRepository } from './projectRepository';

/**
 * The suite runs against `createMemoryBackend()` - the same object the app
 * falls back to when IndexedDB is unavailable - rather than `fake-indexeddb`.
 * That keeps the dependency list at zero and, more usefully, means the fallback
 * path is covered by the repository's own tests instead of being untested code
 * that only executes in Safari private mode.
 */

function imageElement(id: string, imageKey: string): CanvasElement {
  return {
    id,
    type: 'image',
    name: 'Photo',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    imageKey,
    naturalWidth: 10,
    naturalHeight: 10,
    alt: '',
  };
}

function withImages(project: Project, keys: readonly string[]): Project {
  const byId: Record<string, CanvasElement> = {};
  const order: string[] = [];
  keys.forEach((key, index) => {
    const element = imageElement(`img-${index}`, key);
    byId[element.id] = element;
    order.push(element.id);
  });
  return { ...project, elements: { byId, order } };
}

/** An image nested one level inside a group - the shape Finding 1/2 cover. */
function withGroupedImage(project: Project, imageKey: string): Project {
  const image = imageElement('img-nested', imageKey);
  const group = createGroup([image.id], { name: 'Group' });
  return {
    ...project,
    elements: {
      byId: { [image.id]: image, [group.id]: group },
      order: [group.id],
    },
  };
}

let backend: StorageBackend;
let repo: ProjectRepository;

beforeEach(() => {
  backend = createMemoryBackend();
  repo = createProjectRepository(backend);
});

describe('create / load / save', () => {
  it('creates and persists a project', async () => {
    const created = await repo.createProject('  My Sketch  ');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.name).toBe('My Sketch');

    const loaded = await repo.loadProject(created.value.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.project.name).toBe('My Sketch');
    expect(loaded.value.project.elements.order).toEqual([]);
  });

  it('reports a missing project rather than returning an empty one', async () => {
    const loaded = await repo.loadProject('nope');
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe('not-found');
  });

  it('stamps updatedAt at write time', async () => {
    const project = emptyProject('Timed');
    const stale: Project = {
      ...project,
      metadata: { ...project.metadata, updatedAt: '1999-01-01T00:00:00.000Z' },
    };
    const saved = await repo.saveProject(stale);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.updatedAt > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('counts nested group members, not just roots', async () => {
    const project = withGroupedImage(emptyProject('Grouped'), 'k');
    const saved = await repo.saveProject(project);
    expect(saved.ok).toBe(true);
    // One root (the group) holding one member: two elements total, not one.
    if (saved.ok) expect(saved.value.elementCount).toBe(2);

    const listed = await repo.listProjects();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]?.elementCount).toBe(2);
  });

  it('does not inline image data into the stored record', async () => {
    const project = withImages(emptyProject('With image'), ['sha256-a']);
    await repo.saveProject(project);
    const record = await backend.get(STORE_PROJECTS, project.id);
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.value).toMatchObject({ images: {} });
  });

  it('loads a stored record whose elements are partly corrupt', async () => {
    await backend.put(STORE_PROJECTS, 'p-bad', {
      // Current-schema on purpose: this test is about a corrupt element, and a
      // stale version would add an "upgraded" warning that has nothing to do
      // with it. The migration path is covered in migrations.test.ts.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'p-bad',
      name: 'Damaged',
      viewport: { panX: 0, panY: 0, zoom: 1 },
      elements: [imageElement('img-0', 'k'), { type: 'rectangle' }],
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      images: {},
    });

    const loaded = await repo.loadProject('p-bad');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.project.elements.order).toEqual(['img-0']);
    expect(loaded.value.warnings).toHaveLength(1);
  });
});

describe('listProjects', () => {
  it('sorts by updatedAt descending', async () => {
    for (const [id, updatedAt] of [
      ['a', '2026-01-01T00:00:00.000Z'],
      ['b', '2026-03-01T00:00:00.000Z'],
      ['c', '2026-02-01T00:00:00.000Z'],
    ] as const) {
      await backend.put(STORE_PROJECTS, id, {
        schemaVersion: 1,
        id,
        name: id,
        elements: [],
        metadata: { createdAt: updatedAt, updatedAt },
        images: {},
      });
    }

    const listed = await repo.listProjects();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((summary) => summary.id)).toEqual(['b', 'c', 'a']);
  });

  it('skips unreadable rows instead of failing the whole list', async () => {
    await backend.put(STORE_PROJECTS, 'good', {
      id: 'good',
      name: 'Good',
      elements: [1, 2],
      metadata: { updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    await backend.put(STORE_PROJECTS, 'junk', 'a string where a record should be');

    const listed = await repo.listProjects();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.elementCount).toBe(2);
  });
});

describe('deleteProject', () => {
  it('removes the project', async () => {
    const created = await repo.createProject('Doomed');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await repo.deleteProject(created.value.id);
    expect((await repo.loadProject(created.value.id)).ok).toBe(false);
  });

  it('garbage-collects only the image blobs no surviving project references', async () => {
    const keeper = withImages(emptyProject('Keeper'), ['shared', 'kept-only']);
    const doomed = withImages(emptyProject('Doomed'), ['shared', 'doomed-only']);
    await repo.saveProject(keeper);
    await repo.saveProject(doomed);

    for (const key of ['shared', 'kept-only', 'doomed-only', 'orphan']) {
      await backend.put(STORE_IMAGES, key, new Blob(['x']));
    }

    await repo.deleteProject(doomed.id);

    const keys = await backend.getAllKeys(STORE_IMAGES);
    expect(keys.ok).toBe(true);
    if (!keys.ok) return;
    expect([...keys.value].sort()).toEqual(['kept-only', 'shared']);
  });

  it('does not sweep the blob of an image nested inside a surviving group', async () => {
    // Regression for the mark phase only walking root-level elements: a group
    // hides its members one level down in the stored record, and the old scan
    // never looked there.
    const keeper = withGroupedImage(emptyProject('Keeper'), 'nested-key');
    const doomed = withImages(emptyProject('Doomed'), ['doomed-only']);
    await repo.saveProject(keeper);
    await repo.saveProject(doomed);

    for (const key of ['nested-key', 'doomed-only']) {
      await backend.put(STORE_IMAGES, key, new Blob(['x']));
    }

    await repo.deleteProject(doomed.id);

    const keys = await backend.getAllKeys(STORE_IMAGES);
    expect(keys.ok).toBe(true);
    if (!keys.ok) return;
    expect([...keys.value]).toEqual(['nested-key']);
  });
});

describe('duplicateProject', () => {
  it('copies the document under a new id and shares its image blobs', async () => {
    const original = withImages(emptyProject('Original'), ['sha256-a']);
    await repo.saveProject(original);

    const copy = await repo.duplicateProject(original.id);
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;

    expect(copy.value.id).not.toBe(original.id);
    expect(copy.value.name).toBe('Original copy');
    expect(copy.value.elements.order).toEqual(original.elements.order);

    const element = copy.value.elements.byId['img-0'];
    expect(element?.type === 'image' && element.imageKey).toBe('sha256-a');

    const listed = await repo.listProjects();
    expect(listed.ok && listed.value).toHaveLength(2);
  });

  it('fails cleanly for an unknown id', async () => {
    const copy = await repo.duplicateProject('missing');
    expect(copy.ok).toBe(false);
  });
});
