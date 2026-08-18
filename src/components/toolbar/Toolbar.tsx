import {
  ArrowUpRight,
  Circle,
  Download,
  Hand,
  Image as ImageIcon,
  Layers,
  Map,
  Minus,
  Moon,
  MousePointer2,
  PanelRight,
  Pencil,
  Square,
  Sun,
  Redo2,
  Type,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { IconButton, LogoMark } from '@/components/common';
import {
  selectCanRedo,
  selectCanUndo,
  selectRedoLabel,
  selectUndoLabel,
  useCanvasStore,
} from '@/store';
import type { PanelId } from '@/store';
import type { ToolId } from '@/types';
import { useTheme } from '@/hooks/useTheme';
import { SaveStatus } from './SaveStatus';
import { ToolButton } from './ToolButton';
import { ZoomControls } from './ZoomControls';

/**
 * The editor's top bar: tools on the left, view controls on the right.
 *
 * Declared as data rather than as nine hand-written buttons, because the two
 * things that must not drift - the tool's id and the shortcut advertised for it
 * - then sit on one line each. The shortcut strings here are display only; the
 * keys are bound once, in the shortcut registry.
 *
 * Narrow screens: the tool group scrolls horizontally rather than wrapping or
 * shrinking. A wrapped toolbar changes the editor's height, which resizes the
 * canvas, which is a worse outcome than a scroll; shrinking the buttons puts
 * them below a usable touch target, which the spec forbids.
 */

interface ToolDefinition {
  readonly tool: ToolId;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly shortcut?: string;
}

const TOOLS: readonly ToolDefinition[] = [
  { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V' },
  { tool: 'rectangle', icon: Square, label: 'Rectangle', shortcut: 'R' },
  { tool: 'ellipse', icon: Circle, label: 'Ellipse', shortcut: 'O' },
  { tool: 'line', icon: Minus, label: 'Line', shortcut: 'L' },
  { tool: 'arrow', icon: ArrowUpRight, label: 'Arrow', shortcut: 'A' },
  { tool: 'freehand', icon: Pencil, label: 'Draw', shortcut: 'P' },
  { tool: 'text', icon: Type, label: 'Text', shortcut: 'T' },
  { tool: 'image', icon: ImageIcon, label: 'Image', shortcut: 'I' },
  { tool: 'hand', icon: Hand, label: 'Pan', shortcut: 'H' },
];

const PANEL_TOGGLES: readonly { panel: PanelId; icon: LucideIcon; label: string }[] = [
  { panel: 'properties', icon: PanelRight, label: 'Properties panel' },
  { panel: 'layers', icon: Layers, label: 'Layers panel' },
  // The minimap can hide itself, so without a toggle here the only way back is
  // the command palette - discoverable only if you already knew it existed.
  { panel: 'minimap', icon: Map, label: 'Minimap' },
];

export function Toolbar() {
  return (
    <header className="border-edge bg-surface-1 flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <Link
        to="/"
        aria-label="CanvasForge home"
        className="rounded-field ml-1 hidden shrink-0 p-0.5 sm:block"
      >
        <LogoMark size={20} />
      </Link>

      <div
        role="group"
        aria-label="Tools"
        // `min-w-0` lets the flex child actually shrink; without it the group
        // refuses to give up space and pushes the zoom controls off screen. The
        // scrollbar is hidden because a 15px-tall one inside a 48px bar eats a
        // third of the buttons' height - the overflow is still scrollable by
        // touch, trackpad, and keyboard focus.
        className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto"
      >
        {TOOLS.map((definition) => (
          <ToolButton
            key={definition.tool}
            tool={definition.tool}
            icon={definition.icon}
            label={definition.label}
            {...(definition.shortcut !== undefined && { shortcut: definition.shortcut })}
          />
        ))}
      </div>

      {/*
        The save status leads this cluster because it is the only part of it
        whose width changes: "Saved" and "Unsaved changes" differ by about 60px.
        The cluster is right-aligned, so whichever item comes first absorbs that
        change into the empty space on its left and everything after it keeps
        its distance from the right edge. With the status in the middle, every
        undo retitled it and shunted the undo button ~60px out from under the
        cursor - precisely when someone is clicking it repeatedly.
      */}
      <div className="flex shrink-0 items-center gap-1">
        <SaveStatus />
        <span aria-hidden="true" className="bg-edge mx-1 hidden h-5 w-px md:block" />
        <HistoryControls />
        <ExportButton />
        <span aria-hidden="true" className="bg-edge mx-1 hidden h-5 w-px md:block" />
        <ZoomControls />
        <span aria-hidden="true" className="bg-edge mx-1 hidden h-5 w-px sm:block" />
        {PANEL_TOGGLES.map((toggle) => (
          <PanelToggle key={toggle.panel} {...toggle} />
        ))}
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * Split out so each toggle subscribes to its own boolean. Reading `state.panels`
 * would hand every toggle a new object on any panel change and re-render all of
 * them - the same narrow-selector discipline the panels themselves follow.
 */
function PanelToggle({ panel, icon, label }: { panel: PanelId; icon: LucideIcon; label: string }) {
  const visible = useCanvasStore((state) => state.panels[panel]);
  const togglePanel = useCanvasStore((state) => state.togglePanel);

  return (
    <IconButton
      icon={icon}
      label={visible ? `Hide ${label}` : `Show ${label}`}
      active={visible}
      size="sm"
      tooltipSide="bottom"
      onClick={() => {
        togglePanel(panel);
      }}
    />
  );
}

/**
 * Undo and redo as visible controls.
 *
 * The shortcuts have always worked; what was missing was any way to *discover*
 * that undo exists, or to see that there is nothing left to undo. Both read
 * their enabled state and their label from the command table, so the button and
 * the keystroke cannot disagree about either - and the tooltip names the actual
 * operation ("Undo Move 3 elements") rather than a bare verb.
 */
function HistoryControls() {
  const canUndo = useCanvasStore(selectCanUndo);
  const canRedo = useCanvasStore(selectCanRedo);
  const undoLabel = useCanvasStore(selectUndoLabel);
  const redoLabel = useCanvasStore(selectRedoLabel);

  return (
    <>
      <IconButton
        icon={Undo2}
        label={undoLabel === null ? 'Nothing to undo' : `Undo ${undoLabel}`}
        shortcut="mod+z"
        size="sm"
        tooltipSide="bottom"
        disabled={!canUndo}
        onClick={() => {
          useCanvasStore.getState().undo();
        }}
      />
      <IconButton
        icon={Redo2}
        label={redoLabel === null ? 'Nothing to redo' : `Redo ${redoLabel}`}
        shortcut="mod+shift+z"
        size="sm"
        tooltipSide="bottom"
        disabled={!canRedo}
        onClick={() => {
          useCanvasStore.getState().redo();
        }}
      />
    </>
  );
}

/** Export was reachable only through the command palette, which you had to know about. */
function ExportButton() {
  const openDialog = useCanvasStore((state) => state.openDialog);
  const hasContent = useCanvasStore((state) => state.elements.order.length > 0);

  return (
    <IconButton
      icon={Download}
      label="Export…"
      size="sm"
      tooltipSide="bottom"
      disabled={!hasContent}
      onClick={() => {
        openDialog('export');
      }}
    />
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <IconButton
      icon={theme === 'dark' ? Sun : Moon}
      label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      size="sm"
      tooltipSide="left"
      onClick={toggleTheme}
    />
  );
}
