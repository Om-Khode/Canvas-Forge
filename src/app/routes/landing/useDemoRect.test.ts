import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useDemoRect } from './useDemoRect';
import type { Rect, ResizeHandle } from '@/types';

/*
  The clamps are the only part of this worth testing, and they are worth it for
  one reason: they are what stops a visitor dragging the rectangle over the copy
  beside it, or shrinking it to an invisible speck the page can never recover
  from. The transform maths underneath is `resizeElements`, already covered in
  features/elements.
*/

const STAGE = { width: 700, height: 500 };
const START: Rect = { x: 100, y: 100, width: 300, height: 180 };

function drag(x: number, y: number): void {
  window.dispatchEvent(
    Object.assign(new Event('pointermove', { bubbles: true }), { clientX: x, clientY: y })
  );
}

function up(): void {
  window.dispatchEvent(new Event('pointerup', { bubbles: true }));
}

/** Drives a gesture through the hook's own handlers. */
function gesture(
  result: { current: ReturnType<typeof useDemoRect> },
  kind: 'move' | { handle: ResizeHandle },
  to: { x: number; y: number }
): void {
  const event = { button: 0, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} };

  act(() => {
    if (kind === 'move') {
      result.current.onBodyPointerDown(event as never);
    } else {
      result.current.onHandlePointerDown(event as never, kind.handle);
    }
  });
  act(() => {
    drag(to.x, to.y);
  });
  act(() => {
    up();
  });
}

/** A stage that sits at a non-zero offset in the viewport, as a real one does. */
function stageAt(left: number, top: number) {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({
    left,
    top,
    right: left + STAGE.width,
    bottom: top + STAGE.height,
    ...STAGE,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
  return { ...STAGE, element };
}

/** A resize driven from a real viewport position, rather than from an origin of zero. */
function resizeFrom(
  result: { current: ReturnType<typeof useDemoRect> },
  handle: ResizeHandle,
  fromClient: { x: number; y: number },
  toClient: { x: number; y: number }
): void {
  act(() => {
    result.current.onHandlePointerDown(
      { button: 0, clientX: fromClient.x, clientY: fromClient.y, preventDefault() {}, stopPropagation() {} } as never,
      handle
    );
  });
  act(() => {
    drag(toClient.x, toClient.y);
  });
  act(() => {
    up();
  });
}

describe('useDemoRect', () => {
  it('centres itself once the stage has been measured', () => {
    const { result, rerender } = renderHook(
      ({ stage }) => useDemoRect(stage, START),
      { initialProps: { stage: { width: 0, height: 0 } } }
    );

    // Nothing to centre against yet, so it holds its declared position.
    expect(result.current.rect.x).toBe(START.x);

    rerender({ stage: STAGE });
    expect(result.current.rect.x).toBe((STAGE.width - START.width) / 2);
    expect(result.current.rect.y).toBe((STAGE.height - START.height) / 2);
  });

  it('stops centring once the visitor has taken hold of it', () => {
    const { result, rerender } = renderHook(({ stage }) => useDemoRect(stage, START), {
      initialProps: { stage: STAGE },
    });

    gesture(result, 'move', { x: 40, y: 0 });
    const moved = result.current.rect.x;

    // A window resize must not yank the rectangle back to the middle.
    rerender({ stage: { width: 720, height: 520 } });
    expect(result.current.rect.x).toBe(moved);
  });

  it('will not grow past its maximum however far the handle is dragged', () => {
    const { result } = renderHook(() => useDemoRect(STAGE, START));
    const top = result.current.rect.y;

    gesture(result, { handle: 'se' }, { x: 5000, y: 5000 });
    const after = result.current.rect;

    expect(after.width).toBe(460);
    // Height stops at whichever comes first, the maximum or the stage edge.
    // Asserted as the two invariants rather than as the arithmetic between
    // them, so the test survives a change to either bound - and because the
    // anchored edge holding is the actual claim: growth is limited, not
    // relocated.
    expect(after.height).toBeLessThanOrEqual(330);
    expect(after.y + after.height).toBeLessThanOrEqual(STAGE.height - 16);
    expect(after.y).toBeCloseTo(top, 5);
  });

  it('will not shrink below its minimum', () => {
    const { result } = renderHook(() => useDemoRect(STAGE, START));

    gesture(result, { handle: 'se' }, { x: -5000, y: -5000 });

    expect(result.current.rect.width).toBe(132);
    expect(result.current.rect.height).toBe(92);
  });

  it('keeps the rectangle inside the stage when dragged past an edge', () => {
    const { result } = renderHook(() => useDemoRect(STAGE, START));

    gesture(result, 'move', { x: 4000, y: 4000 });
    const { x, y, width, height } = result.current.rect;

    expect(x + width).toBeLessThanOrEqual(STAGE.width);
    expect(y + height).toBeLessThanOrEqual(STAGE.height);

    gesture(result, 'move', { x: -4000, y: -4000 });
    expect(result.current.rect.x).toBeGreaterThanOrEqual(0);
    expect(result.current.rect.y).toBeGreaterThanOrEqual(0);
  });

  it('holds the anchored edge when a resize hits the minimum', () => {
    /*
      The regression this exists for. Dragging the north-west handle inward
      shrinks the box while `resizeElements` correctly pins the south-east
      corner. Clamping the *size* back up to the minimum afterwards - and
      leaving the origin where it was - pushed the pinned edge outward, so the
      rectangle visibly jumped sideways at the exact moment it stopped
      shrinking. Clamping the moving edge against the stationary one cannot
      express that mistake.
    */
    const { result } = renderHook(() => useDemoRect(STAGE, START));
    const before = result.current.rect;
    const right = before.x + before.width;
    const bottom = before.y + before.height;

    gesture(result, { handle: 'nw' }, { x: 5000, y: 5000 });

    const after = result.current.rect;
    expect(after.width).toBe(132);
    expect(after.height).toBe(92);
    // The corner the handle was not dragging has not moved.
    expect(after.x + after.width).toBeCloseTo(right, 5);
    expect(after.y + after.height).toBeCloseTo(bottom, 5);
  });

  it('holds the north-west corner when the south-east handle hits the minimum', () => {
    const { result } = renderHook(() => useDemoRect(STAGE, START));
    const before = result.current.rect;

    gesture(result, { handle: 'se' }, { x: -5000, y: -5000 });

    const after = result.current.rect;
    expect(after.width).toBe(132);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });

  it('holds the opposite edge when a single-axis handle hits the minimum', () => {
    const { result } = renderHook(() => useDemoRect(STAGE, START));
    const before = result.current.rect;
    const right = before.x + before.width;

    gesture(result, { handle: 'w' }, { x: 5000, y: 0 });

    const after = result.current.rect;
    expect(after.width).toBe(132);
    expect(after.x + after.width).toBeCloseTo(right, 5);
    // A west handle must not touch the vertical extent at all.
    expect(after.y).toBeCloseTo(before.y, 5);
    expect(after.height).toBeCloseTo(before.height, 5);
  });

  it('tracks the pointer one-to-one from a stage that is not at the viewport origin', () => {
    /*
      The regression this exists for, and the reason every other test in this
      file missed it: they all drag to ±5000 and assert a clamp, so a resize
      that was pinned to its bound for the *wrong* reason still passed.

      Pointer events report viewport coordinates and the rectangle lives in
      stage-local ones. Handing `resizeElements` a viewport pointer against a
      stage-local box compares two different origins - with the stage 300px
      from the left edge, dragging the east handle *inward* made the box jump
      straight to its maximum and stay there. Only an intermediate value, from
      an offset stage, can tell the difference.
    */
    const OFFSET = { x: 300, y: 100 };
    const { result } = renderHook(() => useDemoRect(stageAt(OFFSET.x, OFFSET.y), START));
    const before = result.current.rect;

    // Grab the east handle where it really is on screen, then pull 50px left.
    const grab = { x: OFFSET.x + before.x + before.width, y: OFFSET.y + before.y + before.height / 2 };
    resizeFrom(result, 'e', grab, { x: grab.x - 50, y: grab.y });

    const after = result.current.rect;
    expect(after.width).toBe(before.width - 50);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.height).toBeCloseTo(before.height, 5);
  });

  it('shrinks its own bounds when the stage is smaller than the maximum', () => {
    const tight = { width: 260, height: 220 };
    const { result } = renderHook(() => useDemoRect(tight, START));

    gesture(result, { handle: 'se' }, { x: 5000, y: 5000 });

    // Stage minus the inset on both sides, never the flat maximum.
    expect(result.current.rect.width).toBeLessThanOrEqual(tight.width - 32);
    expect(result.current.rect.height).toBeLessThanOrEqual(tight.height - 32);
  });
});
