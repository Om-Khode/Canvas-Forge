import { useCallback, useEffect, useState } from 'react';

import { HANDLE_SIZE_PX } from '@/constants';
import type { Rect, ResizeHandle } from '@/types';
import { cn } from '@/utils/cn';
import { useDemoRect } from './useDemoRect';

/*
  A working fragment of the editor, not a picture of one.

  The rectangle moves and resizes through `resizeElements` - the function the
  real tool uses - and the readout reports its actual size. Everything here is
  either true or absent; there is no placeholder pretending to be a screenshot.
*/

const INITIAL: Rect = { x: 48, y: 40, width: 320, height: 190 };

/** Compass positions, and where each sits on the box as a percentage. */
const HANDLES: readonly { handle: ResizeHandle; left: number; top: number; cursor: string }[] = [
  { handle: 'nw', left: 0, top: 0, cursor: 'nwse-resize' },
  { handle: 'n', left: 50, top: 0, cursor: 'ns-resize' },
  { handle: 'ne', left: 100, top: 0, cursor: 'nesw-resize' },
  { handle: 'e', left: 100, top: 50, cursor: 'ew-resize' },
  { handle: 'se', left: 100, top: 100, cursor: 'nwse-resize' },
  { handle: 's', left: 50, top: 100, cursor: 'ns-resize' },
  { handle: 'sw', left: 0, top: 100, cursor: 'nesw-resize' },
  { handle: 'w', left: 0, top: 50, cursor: 'ew-resize' },
];

function useMeasured() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      setSize({
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [node]);

  // A callback ref rather than a `useRef`: the effect has to re-run when the
  // node is replaced, and a ref is not a dependency React can react to.
  const attach = useCallback((element: HTMLDivElement | null) => {
    setNode(element);
  }, []);

  // The node travels with the size: the resize maths needs the stage's position
  // in the viewport to convert a pointer into stage-local coordinates.
  return { attach, stage: { ...size, element: node } };
}

/**
 * The static half of the composition.
 *
 * Two outlined shapes and an arrow, positioned as percentages so the
 * arrangement survives every stage size. They are here because one rectangle
 * alone on a large plane reads as a placeholder rather than as a canvas.
 */
function Backdrop() {
  return (
    <div aria-hidden="true" className="text-edge-strong absolute inset-0">
      <div className="absolute top-[12%] left-[14%] size-24 rounded-full border-2 border-current opacity-70" />
      <div className="absolute right-[16%] bottom-[26%] size-20 rotate-12 rounded-lg border-2 border-current opacity-55" />
      <svg
        className="absolute bottom-[14%] left-[10%] opacity-60"
        width="132"
        height="54"
        viewBox="0 0 132 54"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M3 51C34 51 60 33 122 5" />
        <path d="M104 3h20v20" />
      </svg>
    </div>
  );
}

export function HeroDemo() {
  const { attach, stage } = useMeasured();
  const { rect, active, onBodyPointerDown, onHandlePointerDown } = useDemoRect(stage, INITIAL);

  return (
    <div className="flex h-full flex-col">
      <div ref={attach} className="cf-dot-grid bg-canvas relative flex-1 overflow-hidden">
        <Backdrop />

        <div
          className={cn(
            'border-accent absolute border-2 transition-shadow duration-150',
            active && 'shadow-[0_8px_28px_oklch(0_0_0/0.28)]'
          )}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          {/*
            A literal colour rather than a theme token, because this rectangle is
            *content*, not chrome. The palette deliberately keeps the interface
            near-neutral so whatever the user draws is the only saturated thing on
            screen - painting the demo element in the accent would make the page
            argue with its own design rule, and it would shift between themes when
            a drawn element never would.
          */}
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(135deg, #EFAA55 0%, #E07C2C 100%)' }}
          />
        </div>

        {/* The hit area sits above the fill so the gradient stays a plain paint. */}
        <div
          onPointerDown={onBodyPointerDown}
          role="presentation"
          className={cn('absolute', active ? 'cursor-grabbing' : 'cursor-grab')}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />

        {HANDLES.map(({ handle, left, top, cursor }) => (
          <span
            key={handle}
            onPointerDown={(event) => {
              onHandlePointerDown(event, handle);
            }}
            style={{
              left: rect.x + (rect.width * left) / 100,
              top: rect.y + (rect.height * top) / 100,
              width: HANDLE_SIZE_PX,
              height: HANDLE_SIZE_PX,
              cursor,
            }}
            className="border-accent bg-surface-1 absolute -translate-x-1/2 -translate-y-1/2 border"
          />
        ))}

        <span
          className="text-accent absolute font-mono text-[0.6875rem] tabular-nums"
          style={{ left: rect.x + rect.width - 4, top: rect.y + rect.height + 8 }}
        >
          {Math.round(rect.width)} × {Math.round(rect.height)}
        </span>
      </div>

      <div className="border-edge flex items-center justify-between gap-4 border-t px-4 py-2.5">
        <p className="text-ink-muted text-[0.6875rem]">Drag the rectangle, or any of its handles.</p>
        <p className="text-ink-muted font-mono text-[0.6875rem] tabular-nums">
          {Math.round(rect.x)}, {Math.round(rect.y)}
        </p>
      </div>
    </div>
  );
}
