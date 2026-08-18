import { describe, expect, it } from 'vitest';
import type { InteractionState } from '@/types';
import { worldPoint } from '@/utils/coords';
import { cursorFor, resizeCursor, type CursorInput } from './cursor';

const IDLE: InteractionState = { kind: 'idle' };

function input(overrides: Partial<CursorInput> = {}): CursorInput {
  return {
    state: IDLE,
    tool: 'select',
    hoveredHandle: null,
    hoveringElement: false,
    selectionRotation: 0,
    spaceHeld: false,
    ...overrides,
  };
}

const QUARTER_TURN = Math.PI / 2;

describe('resizeCursor', () => {
  it('maps the eight handles at rest', () => {
    expect(resizeCursor('n', 0)).toBe('ns-resize');
    expect(resizeCursor('s', 0)).toBe('ns-resize');
    expect(resizeCursor('e', 0)).toBe('ew-resize');
    expect(resizeCursor('w', 0)).toBe('ew-resize');
    expect(resizeCursor('ne', 0)).toBe('nesw-resize');
    expect(resizeCursor('sw', 0)).toBe('nesw-resize');
    expect(resizeCursor('nw', 0)).toBe('nwse-resize');
    expect(resizeCursor('se', 0)).toBe('nwse-resize');
  });

  it('rotates with the element: nw on a quarter-turned shape reads as ne', () => {
    expect(resizeCursor('nw', QUARTER_TURN)).toBe(resizeCursor('ne', 0));
    expect(resizeCursor('n', QUARTER_TURN)).toBe(resizeCursor('e', 0));
  });

  it('is symmetric under a half turn, because a resize axis has no direction', () => {
    for (const handle of ['n', 'ne', 'e', 'se'] as const) {
      expect(resizeCursor(handle, Math.PI)).toBe(resizeCursor(handle, 0));
    }
  });

  it('snaps a 45°-off angle to the nearer axis rather than falling through', () => {
    // 22.5° is exactly between two buckets; anything past it belongs to the next.
    expect(resizeCursor('n', (30 * Math.PI) / 180)).toBe('nesw-resize');
    expect(resizeCursor('n', (15 * Math.PI) / 180)).toBe('ns-resize');
  });
});

describe('cursorFor', () => {
  it('shows the pan cursor for space and the hand tool, over anything', () => {
    expect(cursorFor(input({ spaceHeld: true, hoveredHandle: 'se' }))).toBe('grab');
    expect(cursorFor(input({ tool: 'hand', hoveringElement: true }))).toBe('grab');
  });

  it('reflects the in-flight gesture ahead of what is under the pointer', () => {
    const panning: InteractionState = {
      kind: 'panning',
      originScreenX: 0,
      originScreenY: 0,
      originPanX: 0,
      originPanY: 0,
    };
    expect(cursorFor(input({ state: panning }))).toBe('grabbing');
    expect(
      cursorFor(
        input({
          state: {
            kind: 'marquee',
            originWorld: worldPoint(0, 0),
            currentWorld: worldPoint(1, 1),
            additive: false,
          },
        })
      )
    ).toBe('crosshair');
    expect(
      cursorFor(
        input({
          state: {
            kind: 'resizing',
            handle: 'nw',
            originWorld: worldPoint(0, 0),
            currentWorld: worldPoint(0, 0),
            preserveAspect: false,
            fromCenter: false,
          },
          selectionRotation: QUARTER_TURN,
        })
      )
    ).toBe('nesw-resize');
  });

  it('previews the resize axis on hover, before anything is pressed', () => {
    expect(cursorFor(input({ hoveredHandle: 'e' }))).toBe('ew-resize');
    expect(cursorFor(input({ hoveredHandle: 'rotate' }))).toBe('grab');
  });

  it('falls back to move over an element and default over empty canvas', () => {
    expect(cursorFor(input({ hoveringElement: true }))).toBe('move');
    expect(cursorFor(input())).toBe('default');
  });

  it('uses a crosshair for the creation tools and a caret for text', () => {
    expect(cursorFor(input({ tool: 'rectangle' }))).toBe('crosshair');
    expect(cursorFor(input({ tool: 'image' }))).toBe('crosshair');
    expect(cursorFor(input({ tool: 'text' }))).toBe('text');
  });
});
