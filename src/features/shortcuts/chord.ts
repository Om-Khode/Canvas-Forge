/**
 * Keyboard chord parsing and normalization.
 *
 * A chord is written as a lowercase, `+`-separated string in a fixed modifier
 * order: `mod+shift+alt+key`, e.g. `mod+z`, `mod+shift+z`, `delete`, `v`.
 *
 * `mod` means Cmd on macOS and Ctrl everywhere else. Writing shortcuts against
 * `mod` rather than against `ctrl`/`meta` means the table is declared once and
 * the platform difference is resolved in exactly one function - rather than
 * every call site remembering to check `event.metaKey || event.ctrlKey`.
 *
 * Normalizing to a canonical string lets the registry be a plain `Map` lookup
 * on every keydown, which is O(1) and, more usefully, makes the whole thing
 * trivially testable without synthesising DOM events.
 */

export const IS_APPLE_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export interface Chord {
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Lowercased physical key, e.g. `z`, `delete`, `arrowup`, `[`. */
  readonly key: string;
}

const MODIFIER_ALIASES: Readonly<Record<string, keyof Omit<Chord, 'key'>>> = {
  mod: 'mod',
  cmd: 'mod',
  ctrl: 'mod',
  control: 'mod',
  meta: 'mod',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
};

/** Aliases so a shortcut table can be written the way a human says it. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  del: 'delete',
  backspace: 'backspace',
  space: ' ',
  plus: '=',
  minus: '-',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

export function parseChord(input: string): Chord {
  const parts = input.toLowerCase().split('+').filter(Boolean);
  // `mod++` should mean "mod plus the + key"; splitting on '+' loses it, so a
  // trailing empty segment is restored as the literal key.
  const keyPart = input.endsWith('+') ? '+' : parts.pop();

  if (!keyPart) {
    throw new Error(`Invalid shortcut chord: "${input}"`);
  }

  let mod = false;
  let shift = false;
  let alt = false;

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) {
      throw new Error(`Unknown modifier "${part}" in shortcut "${input}"`);
    }
    if (modifier === 'mod') mod = true;
    else if (modifier === 'shift') shift = true;
    else alt = true;
  }

  return { mod, shift, alt, key: KEY_ALIASES[keyPart] ?? keyPart };
}

/** Canonical string form. Modifier order is fixed so two spellings collapse to one key. */
export function serializeChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('mod');
  if (chord.shift) parts.push('shift');
  if (chord.alt) parts.push('alt');
  parts.push(chord.key);
  return parts.join('+');
}

export function normalizeChord(input: string): string {
  return serializeChord(parseChord(input));
}

/**
 * Chord for a keyboard event.
 *
 * `event.key` is used rather than `event.code` because shortcuts are about the
 * character the user believes they typed, and `code` reports physical US-layout
 * positions - `KeyZ` is not where Z sits on an AZERTY keyboard.
 *
 * Shift is *always* recorded, and the key is always lowercased. The tempting
 * alternative - "shift is already baked into event.key, so don't record it" -
 * is true for punctuation (`Shift+/` really does arrive as `?`) and false for
 * letters: `Ctrl+Shift+Z` arrives as key `Z`, which lowercases to `z`, so
 * dropping the shift flag collapses redo onto undo. One rule with no exceptions
 * beats two rules that disagree on the most-used shortcut in the app. The cost
 * is that a punctuation shortcut is written the way the event reports it,
 * e.g. `shift+?`.
 */
export function chordFromEvent(event: KeyboardEvent): Chord {
  return {
    mod: IS_APPLE_PLATFORM ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: event.key.toLowerCase(),
  };
}

export function eventToChordString(event: KeyboardEvent): string {
  return serializeChord(chordFromEvent(event));
}

/** Human-readable form for tooltips and the command palette: `⌘⇧Z` / `Ctrl+Shift+Z`. */
export function formatChord(input: string): string {
  const chord = parseChord(input);
  const keyLabel = formatKey(chord.key);

  if (IS_APPLE_PLATFORM) {
    return `${chord.mod ? '⌘' : ''}${chord.shift ? '⇧' : ''}${chord.alt ? '⌥' : ''}${keyLabel}`;
  }

  const parts: string[] = [];
  if (chord.mod) parts.push('Ctrl');
  if (chord.shift) parts.push('Shift');
  if (chord.alt) parts.push('Alt');
  parts.push(keyLabel);
  return parts.join('+');
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  escape: 'Esc',
  delete: 'Del',
  backspace: '⌫',
  enter: '↵',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ' ': 'Space',
};

function formatKey(key: string): string {
  return KEY_LABELS[key] ?? key.toUpperCase();
}
