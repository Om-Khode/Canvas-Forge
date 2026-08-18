import type { LucideIcon } from 'lucide-react';
import { IconButton } from '@/components/common';
import { useCanvasStore } from '@/store';
import type { ToolId } from '@/types';

export interface ToolButtonProps {
  readonly tool: ToolId;
  readonly icon: LucideIcon;
  readonly label: string;
  /** Displayed in the tooltip and exposed as `aria-keyshortcuts`. */
  readonly shortcut?: string;
}

/**
 * One tool in the toolbar.
 *
 * The selector is `state.tool === tool`, not `state.tool`. Subscribing to the
 * tool id would re-render all nine buttons on every tool change; subscribing to
 * a boolean re-renders exactly the two whose answer flipped. At nine buttons
 * that is not a performance problem - it is the habit that keeps it from
 * becoming one in the layers panel, where the same pattern is load-bearing.
 *
 * The button does not register a keyboard shortcut. There is one `keydown`
 * listener in the application and it dispatches through the shortcut registry
 * (docs/architecture.md §10); a listener here would be a second source of truth
 * that can silently disagree with the palette entry for the same action. The
 * `shortcut` prop is display only.
 */
export function ToolButton({ tool, icon, label, shortcut }: ToolButtonProps) {
  const active = useCanvasStore((state) => state.tool === tool);
  const setTool = useCanvasStore((state) => state.setTool);

  return (
    <IconButton
      icon={icon}
      label={label}
      active={active}
      onClick={() => {
        setTool(tool);
      }}
      {...(shortcut !== undefined && { shortcut })}
    />
  );
}
