/**
 * The command registry.
 *
 * Every user-invocable action in the editor is declared here once as a Command
 * and then *reused* by the toolbar, the menus, the command palette, and the
 * keyboard handler. The alternative - a `keydown` listener in each component
 * that needs one - is how a shortcut and its palette entry silently drift
 * apart, and how three components end up fighting over the same key.
 *
 * There is exactly one `keydown` listener in the application. It lives at the
 * app root, converts the event to a canonical chord string, and looks it up in
 * a Map. Adding a shortcut means adding a table row, not another listener.
 */

import { eventToChordString, normalizeChord } from './chord';

export type CommandId = string;

export type CommandGroup =
  | 'file'
  | 'edit'
  | 'tools'
  | 'view'
  | 'arrange'
  | 'export'
  | 'preferences';

export interface Command {
  readonly id: CommandId;
  /** Shown in the command palette and used as the tooltip/accessible name. */
  readonly title: string;
  readonly group: CommandGroup;
  /** Chord in `mod+shift+key` form. Omit for palette-only commands. */
  readonly shortcut?: string;
  /** Extra words the palette should match on, e.g. "png" for "Export image". */
  readonly keywords?: readonly string[];
  /** Icon name from lucide-react, resolved by the UI layer. */
  readonly icon?: string;
  /** Returning false greys the command out and blocks its shortcut. */
  readonly isEnabled?: () => boolean;
  /** Renders as a checked state in the palette (e.g. "Toggle layers"). */
  readonly isActive?: () => boolean;
  readonly run: () => void;
  /**
   * When true the shortcut still fires while a text field has focus. Reserved
   * for Escape and a handful of mod-chords; almost nothing should set it.
   */
  readonly allowWhileTyping?: boolean;
}

export interface ShortcutRegistry {
  register(command: Command): () => void;
  registerAll(commands: readonly Command[]): () => void;
  get(id: CommandId): Command | undefined;
  list(): readonly Command[];
  /** Resolves a chord to its command, honouring `isEnabled`. */
  match(chord: string): Command | undefined;
  /** Returns true when the event was consumed, so the caller can preventDefault. */
  handleKeyDown(event: KeyboardEvent): boolean;
}

export function createShortcutRegistry(): ShortcutRegistry {
  const commands = new Map<CommandId, Command>();
  const byChord = new Map<string, CommandId>();

  function register(command: Command): () => void {
    if (commands.has(command.id)) {
      throw new Error(`Duplicate command id: ${command.id}`);
    }
    commands.set(command.id, command);

    let chord: string | undefined;
    if (command.shortcut) {
      chord = normalizeChord(command.shortcut);
      const existing = byChord.get(chord);
      if (existing) {
        // Loud on purpose. A silently shadowed shortcut is a bug that only
        // surfaces as "sometimes Ctrl+D does the wrong thing".
        throw new Error(
          `Shortcut "${chord}" is already bound to "${existing}"; cannot bind "${command.id}"`
        );
      }
      byChord.set(chord, command.id);
    }

    return () => {
      commands.delete(command.id);
      if (chord) byChord.delete(chord);
    };
  }

  function registerAll(list: readonly Command[]): () => void {
    const disposers = list.map(register);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  function match(chord: string): Command | undefined {
    const id = byChord.get(chord);
    if (!id) return undefined;
    const command = commands.get(id);
    if (!command) return undefined;
    return command.isEnabled && !command.isEnabled() ? undefined : command;
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    // Repeats from a held key would fire an action per repeat - fine for arrow
    // nudges, wrong for everything else. Nudging opts in by handling keydown
    // itself rather than by going through the registry.
    if (event.isComposing) return false;

    const chord = eventToChordString(event);
    const command = match(chord);
    if (!command) return false;

    if (isTypingTarget(event.target) && !command.allowWhileTyping) return false;

    command.run();
    return true;
  }

  return {
    register,
    registerAll,
    get: (id) => commands.get(id),
    list: () => [...commands.values()],
    match,
    handleKeyDown,
  };
}

/**
 * Whether the event originated in something the user is typing into.
 *
 * Without this, pressing `r` while renaming a layer switches to the rectangle
 * tool instead of typing an "r" - the single most common shortcut bug in
 * editors that bind bare letters.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // Checkboxes, radios, and buttons are inputs but nobody types into them.
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
  }
  return false;
}
