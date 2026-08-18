import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCanvasStore, useCanvasStore } from '@/store';
import type { RectangleElement } from '@/types';
import { CanvasStage } from './CanvasStage';

/**
 * These tests exist to defend one property: **a document change must not
 * re-render the canvas component**. It is the load-bearing claim of the whole
 * architecture (docs/architecture.md §5) and it is one careless
 * `useCanvasStore(s => s.elements)` away from silently disappearing, at which
 * point every pointermove of a drag would run the reconciler.
 */

/**
 * jsdom has no 2D context, so `Renderer`'s constructor would throw. The proxy
 * accepts any property, returns a no-op for anything not assigned, and stores
 * assignments - enough to survive a real frame without asserting anything about
 * pixels, which is explicitly not what this project tests.
 */
function stubCanvasContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const assigned: Record<string, unknown> = { globalAlpha: 1 };
    return new Proxy(assigned, {
      get: (target, property) =>
        property in target
          ? target[property as string]
          : property === 'measureText'
            ? () => ({ width: 0 })
            : () => undefined,
      set: (target, property, value: unknown) => {
        target[property as string] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  });
}

/**
 * rAF held under test control, so "a repaint was requested" is observable.
 *
 * Restored by hand rather than with `vi.unstubAllGlobals()`, which would also
 * tear down the `ResizeObserver` and `matchMedia` stubs that `test/setup.ts`
 * installs once for the whole run.
 */
function stubAnimationFrame(): { flush: () => void; pending: () => number; restore: () => void } {
  const realRequest = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  let queue: FrameRequestCallback[] = [];

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });

  return {
    restore: () => {
      vi.stubGlobal('requestAnimationFrame', realRequest);
      vi.stubGlobal('cancelAnimationFrame', realCancel);
    },
    pending: () => queue.length,
    flush: () => {
      const due = queue;
      queue = [];
      for (const callback of due) callback(0);
    },
  };
}

function rectangle(id: string): RectangleElement {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    strokeStyle: 'solid',
    cornerRadius: 0,
  };
}

describe('CanvasStage', () => {
  let frames: ReturnType<typeof stubAnimationFrame>;

  beforeEach(() => {
    stubCanvasContext();
    frames = stubAnimationFrame();
    resetCanvasStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    frames.restore();
    resetCanvasStore();
  });

  it('does not re-render when the document changes', () => {
    const commits: string[] = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase) => {
      commits.push(phase);
    };

    render(
      <Profiler id="stage" onRender={onRender}>
        <CanvasStage />
      </Profiler>
    );
    expect(commits).toEqual(['mount']);
    frames.flush();

    act(() => {
      useCanvasStore.getState().addElement(rectangle('a'));
      useCanvasStore.getState().updateElement('a', { x: 50 });
      useCanvasStore.getState().select(['a']);
    });

    // Three store writes, zero React work.
    expect(commits).toEqual(['mount']);
  });

  it('schedules exactly one repaint for a burst of store writes', () => {
    render(<CanvasStage />);
    frames.flush();
    expect(frames.pending()).toBe(0);

    act(() => {
      const store = useCanvasStore.getState();
      store.addElement(rectangle('a'));
      store.addElement(rectangle('b'));
      store.addElement(rectangle('c'));
    });

    // rAF coalescing: N writes between two frames produce one paint.
    expect(frames.pending()).toBe(1);
  });

  it('ignores store changes the renderer does not draw', () => {
    render(<CanvasStage />);
    frames.flush();

    act(() => {
      useCanvasStore.getState().setSaveStatus('saving');
      useCanvasStore.getState().openDialog('export');
    });

    expect(frames.pending()).toBe(0);
  });

  it('exposes the canvas to keyboard and assistive technology', () => {
    render(<CanvasStage />);
    const canvas = screen.getByLabelText('Design canvas');

    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('tabindex', '0');
    // Without `touch-action: none` the browser claims the gesture for scrolling
    // and pointermove stops arriving mid-drag on every touch device.
    expect(canvas).toHaveClass('touch-none');
    expect(canvas).toHaveAccessibleDescription(/layers panel/i);
  });
});
