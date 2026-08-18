import { describe, expect, it, vi } from 'vitest';
import {
  createClipboard,
  duplicateElements,
  parsePayload,
  placeForPaste,
  serializePayload,
  type SystemClipboard,
} from './clipboard';
import { createEllipse, createRectangle } from '@/features/elements/factory';
import { PASTE_OFFSET } from '@/constants';
import type { CanvasElement, WorldRect } from '@/types';

function rect(x: number, y: number, width: number, height: number): WorldRect {
  return { x, y, width, height } as WorldRect;
}

const DOC = 'doc-1';
const OTHER_DOC = 'doc-2';
const ANCHOR = { anchorWorld: { x: 0, y: 0 } };

function selection(): CanvasElement[] {
  return [createRectangle(rect(10, 20, 100, 50)), createEllipse(rect(200, 20, 60, 60))];
}

function stubSystem(): SystemClipboard & { text: string | null } {
  const stub = {
    text: null as string | null,
    writeText: vi.fn((text: string) => {
      stub.text = text;
      return Promise.resolve();
    }),
    readText: vi.fn(() => Promise.resolve(stub.text ?? '')),
  };
  return stub;
}

describe('copy and paste', () => {
  it('refuses to copy an empty selection', () => {
    const clipboard = createClipboard({ system: null });

    expect(clipboard.copy({ elements: [], documentId: DOC })).toBe(false);
    expect(clipboard.isEmpty()).toBe(true);
  });

  it('gives every pasted element a fresh id', () => {
    const clipboard = createClipboard({ system: null });
    const elements = selection();
    clipboard.copy({ elements, documentId: DOC });

    const pasted = clipboard.paste({ documentId: DOC, ...ANCHOR });

    expect(pasted).not.toBeNull();
    const originalIds = new Set(elements.map((element) => element.id));
    for (const element of pasted?.elements ?? []) {
      expect(originalIds.has(element.id)).toBe(false);
    }
    expect(new Set(pasted?.elements.map((element) => element.id)).size).toBe(2);
  });

  it('maps every original id to its clone', () => {
    const clipboard = createClipboard({ system: null });
    const elements = selection();
    clipboard.copy({ elements, documentId: DOC });

    const pasted = clipboard.paste({ documentId: DOC, ...ANCHOR });

    expect(pasted?.idMap.size).toBe(2);
    for (const element of elements) {
      expect(pasted?.idMap.get(element.id)).toBeDefined();
      expect(pasted?.idMap.get(element.id)).not.toBe(element.id);
    }
  });

  it('pastes twice without the two copies colliding', () => {
    const clipboard = createClipboard({ system: null });
    clipboard.copy({ elements: selection(), documentId: DOC });

    const first = clipboard.paste({ documentId: DOC, ...ANCHOR });
    const second = clipboard.paste({ documentId: DOC, ...ANCHOR });

    const firstIds = new Set(first?.elements.map((element) => element.id));
    for (const element of second?.elements ?? []) {
      expect(firstIds.has(element.id)).toBe(false);
    }
  });

  it('offsets a same-document paste so the copy sits on top of the original', () => {
    const clipboard = createClipboard({ system: null });
    const elements = selection();
    clipboard.copy({ elements, documentId: DOC });

    const pasted = clipboard.paste({ documentId: DOC, ...ANCHOR });

    expect(pasted?.elements[0]?.x).toBe(10 + PASTE_OFFSET);
    expect(pasted?.elements[0]?.y).toBe(20 + PASTE_OFFSET);
    // Relative geometry inside the set is preserved - a multi-select paste must
    // not rearrange the elements against each other.
    expect((pasted?.elements[1]?.x ?? 0) - (pasted?.elements[0]?.x ?? 0)).toBe(190);
  });

  it('centres a cross-document paste on the anchor instead of using stale coordinates', () => {
    const clipboard = createClipboard({ system: null });
    clipboard.copy({ elements: selection(), documentId: OTHER_DOC });

    const pasted = clipboard.paste({ documentId: DOC, anchorWorld: { x: 500, y: 500 } });

    // Source bounds are x 10..260, y 20..80 → centre (135, 50).
    expect(pasted?.elements[0]?.x).toBeCloseTo(10 + (500 - 135), 6);
    expect(pasted?.elements[0]?.y).toBeCloseTo(20 + (500 - 50), 6);
  });

  it('reports nothing to paste when the buffer is empty', () => {
    const clipboard = createClipboard({ system: null });

    expect(clipboard.paste({ documentId: DOC, ...ANCHOR })).toBeNull();
    expect(clipboard.canPaste()).toBe(false);
  });
});

describe('the system clipboard bridge', () => {
  it('writes a serialized payload alongside the internal copy', () => {
    const system = stubSystem();
    const clipboard = createClipboard({ system });

    clipboard.copy({ elements: selection(), documentId: DOC });

    expect(system.writeText).toHaveBeenCalledTimes(1);
    expect(parsePayload(system.text ?? '')?.elements).toHaveLength(2);
  });

  it('degrades silently when the write is refused', async () => {
    const system: SystemClipboard = {
      writeText: () => Promise.reject(new Error('NotAllowedError')),
      readText: () => Promise.reject(new Error('NotAllowedError')),
    };
    const clipboard = createClipboard({ system });

    expect(clipboard.copy({ elements: selection(), documentId: DOC })).toBe(true);
    await Promise.resolve();
    expect(clipboard.paste({ documentId: DOC, ...ANCHOR })).not.toBeNull();
  });

  it('round-trips a multi-selection through the serialized form', async () => {
    const system = stubSystem();
    const source = createClipboard({ system });
    source.copy({ elements: selection(), documentId: OTHER_DOC });

    // A second tab: its own internal buffer is empty, so it falls back to the
    // system clipboard and re-anchors because the document id differs.
    const other = createClipboard({ system });
    const pasted = await other.pasteAsync({ documentId: DOC, anchorWorld: { x: 0, y: 0 } });

    expect(pasted?.source).toBe('system');
    expect(pasted?.elements).toHaveLength(2);
    expect(pasted?.elements.map((element) => element.type)).toEqual(['rectangle', 'ellipse']);
    expect((pasted?.elements[1]?.x ?? 0) - (pasted?.elements[0]?.x ?? 0)).toBe(190);
  });

  it('prefers the internal buffer over an async read', async () => {
    const system = stubSystem();
    const clipboard = createClipboard({ system });
    clipboard.copy({ elements: selection(), documentId: DOC });

    const pasted = await clipboard.pasteAsync({ documentId: DOC, ...ANCHOR });

    expect(pasted?.source).toBe('internal');
    expect(system.readText).not.toHaveBeenCalled();
  });

  it('takes the payload straight off a paste event, with no permission read', () => {
    const clipboard = createClipboard({ system: null });
    const payload = serializePayload({
      kind: 'canvasforge/clipboard',
      version: 1,
      documentId: OTHER_DOC,
      elements: selection(),
    });
    const event = {
      clipboardData: { getData: () => payload },
    } as unknown as ClipboardEvent;

    const pasted = clipboard.pasteFromEvent(event, { documentId: DOC, ...ANCHOR });

    expect(pasted?.source).toBe('system');
    expect(pasted?.elements).toHaveLength(2);
  });

  it('ignores clipboard text that is not one of ours', () => {
    const clipboard = createClipboard({ system: null });
    const event = {
      clipboardData: { getData: () => 'https://example.com' },
    } as unknown as ClipboardEvent;

    expect(clipboard.pasteFromEvent(event, { documentId: DOC, ...ANCHOR })).toBeNull();
  });
});

describe('parsePayload', () => {
  it('rejects malformed JSON without throwing', () => {
    expect(parsePayload('{not json')).toBeNull();
  });

  it('rejects a payload from a newer version', () => {
    expect(
      parsePayload(JSON.stringify({ kind: 'canvasforge/clipboard', version: 99, elements: [] }))
    ).toBeNull();
  });

  it('drops elements that fail validation rather than the whole payload', () => {
    const text = JSON.stringify({
      kind: 'canvasforge/clipboard',
      version: 1,
      documentId: DOC,
      elements: [{ type: 'nonsense' }, ...selection()],
    });

    expect(parsePayload(text)?.elements).toHaveLength(2);
  });

  it('never lets a pasted group claim an element already in this document', () => {
    // The cross-tab case: the payload's `childIds` name ids from a document
    // this tab has never seen, and one of them happens to exist here. Placing
    // the paste re-ids everything, and a child that did not travel with the
    // group is dropped rather than carried across.
    const local = createRectangle(rect(0, 0, 10, 10));
    const text = JSON.stringify({
      kind: 'canvasforge/clipboard',
      version: 1,
      documentId: OTHER_DOC,
      elements: [
        {
          id: 'foreign-group',
          type: 'group',
          name: 'Group 1',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          childIds: [local.id],
        },
      ],
    });

    const payload = parsePayload(text);
    if (payload === null) throw new Error('the payload should have parsed');
    const placed = placeForPaste(payload, { documentId: DOC, ...ANCHOR });

    expect(placed.elements[0]).toMatchObject({ type: 'group', childIds: [] });
  });

  it('returns null when nothing survives validation', () => {
    const text = JSON.stringify({
      kind: 'canvasforge/clipboard',
      version: 1,
      elements: [{ type: 'nonsense' }],
    });

    expect(parsePayload(text)).toBeNull();
  });
});

describe('duplicateElements', () => {
  it('offsets and re-ids without touching the clipboard', () => {
    const clipboard = createClipboard({ system: null });
    const elements = selection();

    const duplicated = duplicateElements(elements);

    expect(duplicated?.elements[0]?.id).not.toBe(elements[0]?.id);
    expect(duplicated?.elements[0]?.x).toBe(10 + PASTE_OFFSET);
    expect(clipboard.isEmpty()).toBe(true);
  });

  it('is a no-op for an empty selection', () => {
    expect(duplicateElements([])).toBeNull();
  });
});
