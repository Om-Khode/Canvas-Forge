import { describe, expect, it } from 'vitest';
import type { CanvasElement, Project } from '@/types';
import { exportProjectJson, importProjectJson, jsonFilename } from './json';

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

const RECT: CanvasElement = {
  id: 'rect-1',
  type: 'rectangle',
  name: 'Card',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
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

const IMAGE: CanvasElement = {
  id: 'image-1',
  type: 'image',
  name: 'Photo',
  x: 10,
  y: 10,
  width: 80,
  height: 40,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  imageKey: 'sha256-abc',
  naturalWidth: 800,
  naturalHeight: 400,
  alt: '',
};

const PROJECT: Project = {
  id: 'p1',
  name: 'My Project',
  viewport: { panX: 0, panY: 0, zoom: 1 },
  elements: { byId: { 'rect-1': RECT, 'image-1': IMAGE }, order: ['rect-1', 'image-1'] },
  metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
};

describe('exportProjectJson / importProjectJson', () => {
  it('round-trips a project with an inlined image', () => {
    const exported = exportProjectJson(PROJECT, { 'sha256-abc': PNG_DATA_URI });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const imported = importProjectJson(exported.value);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.project.elements.order).toEqual(['rect-1', 'image-1']);
    expect(imported.value.images).toEqual({ 'sha256-abc': PNG_DATA_URI });
    expect(imported.value.warnings).toEqual([]);
  });

  it('rejects malformed JSON cleanly instead of throwing', () => {
    const result = importProjectJson('{ "schemaVersion": 1, ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed-json');
  });

  it('rejects valid JSON that is not a project', () => {
    const result = importProjectJson('[1, 2, 3]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-an-object');
  });

  it('refuses a file from a newer schema version', () => {
    const result = importProjectJson(JSON.stringify({ schemaVersion: 99, elements: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('newer-version');
  });

  it('imports a file with one broken element and reports it', () => {
    const exported = exportProjectJson(PROJECT);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const parsed = JSON.parse(exported.value) as { elements: unknown[] };
    parsed.elements.push({ type: 'rectangle', name: 'no id' });

    const imported = importProjectJson(JSON.stringify(parsed));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.project.elements.order).toEqual(['rect-1', 'image-1']);
    expect(imported.value.warnings).toHaveLength(1);
  });

  it('strips path separators out of the filename', () => {
    expect(jsonFilename('My Project')).toBe('my-project.canvasforge.json');
    expect(jsonFilename('../../etc/passwd')).toBe('etc-passwd.canvasforge.json');
    expect(jsonFilename('   ')).toBe('canvasforge-project.canvasforge.json');
  });
});
