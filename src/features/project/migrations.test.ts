import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@/constants/storage';
import { migrateDocument, migrations, type MigrationChain } from './migrations';
import { deserializeProject } from './serialize';

/**
 * A synthetic two-step chain. There is only one real schema version today, so
 * the mechanism would otherwise be untested until the first breaking change -
 * exactly the moment it must already work.
 */
const SYNTHETIC: MigrationChain = {
  0: (doc) => ({ ...(doc as object), schemaVersion: 1, steps: ['v0->v1'] }),
  1: (doc) => {
    const record = doc as { steps?: string[] };
    return { ...(doc as object), schemaVersion: 2, steps: [...(record.steps ?? []), 'v1->v2'] };
  },
};

describe('migrateDocument', () => {
  it('is a no-op for a document already at the target version', () => {
    const result = migrateDocument({ schemaVersion: CURRENT_SCHEMA_VERSION, elements: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toEqual([]);
    expect(result.value.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('runs the chain in ascending order', () => {
    const result = migrateDocument({ schemaVersion: 0 }, SYNTHETIC, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toEqual([0, 1]);
    expect(result.value.doc).toMatchObject({ schemaVersion: 2, steps: ['v0->v1', 'v1->v2'] });
  });

  it('starts from the document version, not from zero', () => {
    const result = migrateDocument({ schemaVersion: 1 }, SYNTHETIC, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toEqual([1]);
    expect(result.value.doc).toMatchObject({ steps: ['v1->v2'] });
  });

  it('stamps the target version even if a migration forgets to', () => {
    const forgetful: MigrationChain = { 0: (doc) => ({ ...(doc as object), migrated: true }) };
    const result = migrateDocument({ schemaVersion: 0 }, forgetful, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.doc).toMatchObject({ schemaVersion: 1, migrated: true });
  });

  it('refuses a document from a newer version instead of guessing', () => {
    const result = migrateDocument({ schemaVersion: CURRENT_SCHEMA_VERSION + 5, elements: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('newer-version');
    expect(result.error.message).toContain('newer version');
  });

  it('reports a gap in the chain rather than skipping it', () => {
    const result = migrateDocument({ schemaVersion: 0 }, { 1: (doc) => doc }, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing-migration');
  });

  it('turns a throwing migration into an error result', () => {
    const broken: MigrationChain = {
      0: () => {
        throw new Error('bad field');
      },
    };
    const result = migrateDocument({ schemaVersion: 0 }, broken, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('migration-failed');
    expect(result.error.message).toContain('bad field');
  });

  it('rejects documents with no usable schema version', () => {
    expect(migrateDocument({}).ok).toBe(false);
    expect(migrateDocument({ schemaVersion: '1' }).ok).toBe(false);
    expect(migrateDocument({ schemaVersion: 1.5 }).ok).toBe(false);
    expect(migrateDocument([]).ok).toBe(false);
    expect(migrateDocument(null).ok).toBe(false);
  });
});

describe('the live chain', () => {
  it('registers a step for every version below the current one', () => {
    for (let version = 1; version < CURRENT_SCHEMA_VERSION; version++) {
      expect(migrations[version], `no migration from schema ${version}`).toBeTypeOf('function');
    }
  });
});

describe('migration v1 to v2', () => {
  const V1_RECT = {
    id: 'rect-1',
    type: 'rectangle',
    name: 'Card',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    stroke: '#1c1c1f',
    strokeWidth: 2,
    strokeStyle: 'solid',
    fill: '#ffffff',
    cornerRadius: 4,
  };

  const V1_DOC = {
    schemaVersion: 1,
    id: 'p',
    name: 'P',
    viewport: { panX: 0, panY: 0, zoom: 1 },
    elements: [V1_RECT],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    images: {},
  };

  it('accepts a flat v1 document as roots with no children', () => {
    const result = migrateDocument(V1_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toEqual([1]);
    expect(result.value.doc).toMatchObject({ schemaVersion: 2, elements: [V1_RECT] });
  });

  it('loads a v1 document end to end and reports the upgrade', () => {
    const loaded = deserializeProject(V1_DOC);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.project.elements.order).toEqual(['rect-1']);
    expect(loaded.value.warnings).toEqual(['Upgraded from schema 1 to 2.']);
  });
});
