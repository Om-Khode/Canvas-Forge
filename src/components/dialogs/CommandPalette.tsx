import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, EmptyState, Kbd } from '@/components/common';
import { commandRegistry } from '@/features/commands';
import type { Command, CommandGroup } from '@/features/shortcuts/registry';
import { useCanvasStore } from '@/store';
import { cn } from '@/utils/cn';
import { SearchX } from 'lucide-react';

/**
 * The command palette - ⌘K.
 *
 * It renders the *same* `Command[]` the keyboard dispatches, so a command
 * cannot exist in one and not the other, and its listed shortcut cannot
 * disagree with the key that actually runs it.
 *
 * ## The pattern is a combobox, not a search box next to a div
 *
 * `role="combobox"` on the input, `role="listbox"` on the results, `role="option"`
 * on each row, and `aria-activedescendant` pointing at the highlighted one. That
 * combination is what lets focus stay in the input - so typing keeps working -
 * while a screen reader still announces the highlighted result as the selection
 * moves. Roving `tabIndex` would be the wrong tool: it moves real focus out of
 * the input, and the next keystroke would go to a row instead of the query.
 *
 * Disabled commands are **shown, not hidden**. "Undo is here but there is
 * nothing to undo" is useful; a command that vanishes teaches the user it does
 * not exist. They are skipped by arrow navigation and cannot be run.
 */

const GROUP_LABELS: Readonly<Record<CommandGroup, string>> = {
  file: 'Project',
  edit: 'Edit',
  tools: 'Tools',
  view: 'View',
  arrange: 'Arrange',
  export: 'Export',
  preferences: 'Preferences',
};

/** Rendering order. Fixed rather than derived so the palette's shape is stable. */
const GROUP_ORDER: readonly CommandGroup[] = [
  'edit',
  'tools',
  'view',
  'file',
  'export',
  'arrange',
  'preferences',
];

const WORD_BOUNDARIES = ' -–—/·(';

/**
 * Subsequence scoring, not substring matching.
 *
 * Substring matching means "exp png" finds nothing and "epng" finds nothing -
 * both of which a user will type. A subsequence match finds "Export PNG" from
 * either. The bonuses are what stop it from being *too* permissive: a character
 * that lands on a word start scores six times one that lands mid-word, and a
 * run of consecutive matches compounds, so "Export PNG" outranks "Toggle
 * properties panel" for the query "ep" even though both technically match.
 */
function fuzzyScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  let score = 0;
  let cursor = 0;
  let streak = 0;

  for (const character of query) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    const previous = found === 0 ? ' ' : (haystack[found - 1] ?? ' ');
    score += WORD_BOUNDARIES.includes(previous) ? 6 : 1;
    streak = found === cursor ? streak + 2 : 0;
    score += streak;
    cursor = found + 1;
  }
  // Tie-break towards the shorter title, so "Copy" beats "Duplicate project".
  return score - text.length * 0.01;
}

function scoreCommand(command: Command, query: string): number | null {
  // Title carries the most weight; group and keywords exist so "png", "clone",
  // or "dark" find the right row without appearing in its label.
  const title = fuzzyScore(command.title, query);
  let best = title === null ? null : title * 3;

  for (const term of [GROUP_LABELS[command.group], ...(command.keywords ?? [])]) {
    const score = fuzzyScore(term, query);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

interface ResultGroup {
  readonly group: CommandGroup;
  readonly commands: readonly Command[];
}

function buildResults(commands: readonly Command[], query: string): ResultGroup[] {
  const trimmed = query.trim().toLowerCase();
  const matched =
    trimmed.length === 0
      ? commands.map((command) => ({ command, score: 0 }))
      : commands
          .map((command) => ({ command, score: scoreCommand(command, trimmed) }))
          .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
          .sort((a, b) => b.score - a.score);

  return GROUP_ORDER.map((group) => ({
    group,
    commands: matched
      .filter((entry) => entry.command.group === group)
      .map((entry) => entry.command),
  })).filter((entry) => entry.commands.length > 0);
}

export function CommandPalette() {
  const open = useCanvasStore((state) => state.activeDialog === 'command-palette');
  const closeDialog = useCanvasStore((state) => state.closeDialog);

  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = 'command-palette-results';

  // `registry.list()` is read while open rather than subscribed to: the table is
  // registered once at editor mount and never changes afterwards, so a
  // subscription would be machinery for an event that cannot happen.
  const groups = useMemo(
    () => (open ? buildResults(commandRegistry.list(), query) : []),
    [open, query]
  );
  const flat = useMemo(() => groups.flatMap((entry) => entry.commands), [groups]);
  const runnable = useMemo(() => flat.filter((command) => command.isEnabled?.() !== false), [flat]);

  /**
   * The highlight is *derived*, not stored: `activeId` is only a preference,
   * and the first runnable result is the answer whenever that preference has
   * been filtered away. Storing it and re-anchoring it in an effect would mean
   * a render where the palette has no selection, and an extra render to fix it.
   */
  const active = runnable.find((command) => command.id === activeId) ?? runnable[0];

  // Reset on open/close by adjusting state during render - React's sanctioned
  // alternative to an effect, and the pattern `Dialog` itself uses.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setQuery('');
    setActiveId(null);
  }

  // Keeps the highlight visible while arrowing past the fold. Focus never
  // moves, so nothing else would scroll the list.
  useEffect(() => {
    if (active === undefined) return;
    const option = document.getElementById(`cmd-${active.id}`);
    if (option === null) return;
    // Guarded by `typeof` rather than optional chaining: the DOM lib declares
    // `scrollIntoView` as always present, so a type-level check is dead code the
    // compiler can see through - but jsdom genuinely does not implement it.
    if (typeof option.scrollIntoView !== 'function') return;
    option.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (command: Command): void => {
    if (command.isEnabled?.() === false) return;
    // Closed *before* running: several commands open another dialog, and
    // closing afterwards would immediately shut it again.
    closeDialog();
    command.run();
  };

  const step = (delta: number): void => {
    if (runnable.length === 0) return;
    // Indexed by identity rather than by the stored id, which may have been
    // filtered out - in which case `active` is already the first result and
    // Down must move to the second, not back to the first.
    const index = active === undefined ? -1 : runnable.indexOf(active);
    const next = runnable[(index + delta + runnable.length) % runnable.length];
    if (next !== undefined) setActiveId(next.id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'Home') setActiveId(runnable[0]?.id ?? null);
    else if (event.key === 'End') setActiveId(runnable[runnable.length - 1]?.id ?? null);
    else if (event.key === 'Enter' && active !== undefined) run(active);
    else return;
    event.preventDefault();
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      title="Command palette"
      description="Search for an action, then press Enter."
      size="lg"
      initialFocusRef={inputRef}
      showCloseButton={false}
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Search commands"
        aria-activedescendant={active === undefined ? undefined : `cmd-${active.id}`}
        placeholder="Type a command…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'border-edge bg-surface-2 rounded-field text-ink placeholder:text-ink-muted',
          'focus:border-accent mb-3 h-10 w-full border px-3 text-sm outline-none'
        )}
      />

      {flat.length === 0 ? (
        <EmptyState
          icon={SearchX}
          size="md"
          title="No matching commands"
          description="Try a shorter query, or the name of the panel you are looking for."
        />
      ) : (
        <div id={listboxId} role="listbox" aria-label="Commands" className="flex flex-col gap-3">
          {groups.map((entry) => (
            <div key={entry.group} role="group" aria-labelledby={`cmd-group-${entry.group}`}>
              <p
                id={`cmd-group-${entry.group}`}
                className="text-ink-muted px-2 pb-1 text-[0.6875rem] font-medium tracking-wide uppercase"
              >
                {GROUP_LABELS[entry.group]}
              </p>
              {entry.commands.map((command) => {
                const disabled = command.isEnabled?.() === false;
                const selected = command.id === active?.id;
                return (
                  <div
                    key={command.id}
                    id={`cmd-${command.id}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={disabled || undefined}
                    onMouseMove={() => {
                      if (!disabled) setActiveId(command.id);
                    }}
                    onClick={() => {
                      run(command);
                    }}
                    className={cn(
                      'rounded-control flex h-9 items-center gap-3 px-2 text-[0.8125rem]',
                      disabled
                        ? 'text-ink-muted cursor-not-allowed opacity-60'
                        : 'text-ink cursor-pointer',
                      selected && !disabled && 'bg-surface-3'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{command.title}</span>
                    {command.isActive?.() === true && (
                      <span className="text-accent text-[0.6875rem] font-medium">On</span>
                    )}
                    {command.shortcut !== undefined && <Kbd keys={command.shortcut} tone="muted" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
