/* eslint-disable react-refresh/only-export-components --
   `IS_MAC` and `formatShortcut` are the platform table this component is built
   on, and the shortcut registry and command palette need them too. Splitting
   them into their own module to satisfy fast refresh would separate the mapping
   from the only component that renders it, for a dev-server nicety. */
import { cn } from '@/utils/cn';

/**
 * Detected once, at module load. Platform doesn't change mid-session, and a
 * per-render check would mean every keycap in the command palette re-runs a
 * regex over the UA string.
 *
 * `navigator.platform` is deprecated but still the most reliable Mac signal;
 * the UA fallback catches the browsers that have frozen or removed it.
 */
export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/**
 * How each token renders. `mod` is the whole point of this map: shortcuts are
 * declared once, platform-neutrally, as `mod+shift+z`, and the registry, the
 * tooltips and the command palette all read the same string. Nothing in the
 * codebase branches on platform except this table.
 */
const KEY_LABELS: Record<string, { mac: string; other: string }> = {
  mod: { mac: '⌘', other: 'Ctrl' },
  meta: { mac: '⌘', other: 'Win' },
  ctrl: { mac: '⌃', other: 'Ctrl' },
  alt: { mac: '⌥', other: 'Alt' },
  option: { mac: '⌥', other: 'Alt' },
  shift: { mac: '⇧', other: 'Shift' },
  enter: { mac: '↵', other: 'Enter' },
  return: { mac: '↵', other: 'Enter' },
  escape: { mac: 'Esc', other: 'Esc' },
  esc: { mac: 'Esc', other: 'Esc' },
  backspace: { mac: '⌫', other: 'Backspace' },
  delete: { mac: '⌦', other: 'Del' },
  tab: { mac: '⇥', other: 'Tab' },
  space: { mac: 'Space', other: 'Space' },
  arrowup: { mac: '↑', other: '↑' },
  arrowdown: { mac: '↓', other: '↓' },
  arrowleft: { mac: '←', other: '←' },
  arrowright: { mac: '→', other: '→' },
  plus: { mac: '+', other: '+' },
  minus: { mac: '−', other: '−' },
};

/** `'mod+shift+z'` → `['⌘', '⇧', 'Z']` on a Mac. Exported for the palette's search index. */
export function formatShortcut(shortcut: string): string[] {
  return shortcut
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .map((token) => {
      const mapped = KEY_LABELS[token];
      if (mapped !== undefined) return IS_MAC ? mapped.mac : mapped.other;
      return token.length === 1
        ? token.toUpperCase()
        : token.charAt(0).toUpperCase() + token.slice(1);
    });
}

export interface KbdProps {
  /** Platform-neutral chord, e.g. `mod+shift+z` or a bare key like `v`. */
  keys: string;
  /** Muted sits on a tinted surface (tooltips); default sits on the page. */
  tone?: 'default' | 'muted' | 'inverted';
  className?: string;
}

const TONE_CLASSES: Record<NonNullable<KbdProps['tone']>, string> = {
  default: 'bg-surface-2 text-ink-soft border-edge',
  muted: 'bg-surface-3 text-ink-soft border-transparent',
  inverted: 'bg-tooltip-key text-tooltip-muted border-transparent',
};

/**
 * Keycaps for a shortcut. Renders one `<kbd>` per key inside a wrapper `<kbd>`
 * so assistive tech announces the chord as a unit - nesting is the semantic the
 * HTML spec actually gives for compound shortcuts.
 */
export function Kbd({ keys, tone = 'default', className }: KbdProps) {
  const parts = formatShortcut(keys);
  if (parts.length === 0) return null;

  return (
    <kbd className={cn('inline-flex items-center gap-0.5 font-sans', className)}>
      {parts.map((part, index) => (
        <kbd
          key={`${part}-${index}`}
          className={cn(
            'inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center',
            'rounded-[0.25rem] border px-1',
            'text-[0.6875rem] leading-none font-medium',
            TONE_CLASSES[tone]
          )}
        >
          {part}
        </kbd>
      ))}
    </kbd>
  );
}
