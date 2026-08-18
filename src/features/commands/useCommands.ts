/**
 * The editor's keyboard, in one place.
 *
 * There is exactly **one** `keydown` listener in the application and it lives
 * here. The alternative - a listener per component that wants a shortcut - is
 * how three components end up fighting over the same key, how a shortcut and
 * its palette entry drift apart, and how a stale listener keeps firing after
 * its component unmounts. Adding a shortcut means adding a row to the command
 * table, never another listener.
 *
 * `preventDefault` is called *only* when the registry reports the event
 * consumed. That distinction matters: Ctrl+F, Tab, and the browser's own
 * shortcuts must keep working, and swallowing every keydown "to be safe" breaks
 * screen-reader navigation in ways that are very hard to notice from the
 * outside.
 *
 * Two things do not go through the registry, for reasons given at each:
 * Backspace as an alias for Delete, and arrow-key nudging.
 */

import {
  applyPastedElements,
  createCommands,
  setExportFormat,
  viewportCenterWorld,
  type CommandDeps,
  type ExportFormat,
} from '@/features/commands/createCommands';
import { clipboard } from '@/features/commands/clipboard';
import { translateElements } from '@/features/elements/operations';
import { projectSession } from '@/features/project/useProjectSession';
import { gestureTargets } from '@/features/selection/gestureTargets';
import {
  createShortcutRegistry,
  isTypingTarget,
  type ShortcutRegistry,
} from '@/features/shortcuts/registry';
import { setTheme } from '@/hooks/useTheme';
import { useCanvasStore, type CanvasStore } from '@/store';
import type { CanvasElement, Vec2 } from '@/types';
import { useEffect } from 'react';
import type { StoreApi } from 'zustand';

/**
 * One registry for the whole application.
 *
 * A module singleton rather than component state because two consumers need the
 * *same* one: `useCommands` fills it and owns the keyboard, and the command
 * palette renders its contents. A per-component registry would give the palette
 * an empty list, and a second `useCommands` call would install a second keydown
 * listener that runs every command twice.
 */
export const commandRegistry: ShortcutRegistry = createShortcutRegistry();

/** World units per arrow press, and per arrow press with Shift held. */
const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;

/**
 * Safety net for a nudge whose `keyup` never arrives - a window that loses
 * focus mid-hold, or an OS-level shortcut swallowing the release. Comfortably
 * longer than the ~30ms key-repeat interval, so it can never fire mid-slide.
 */
const NUDGE_IDLE_COMMIT_MS = 500;

const ARROW_DELTAS: Readonly<Record<string, Vec2>> = {
  arrowup: { x: 0, y: -1 },
  arrowdown: { x: 0, y: 1 },
  arrowleft: { x: -1, y: 0 },
  arrowright: { x: 1, y: 0 },
};

/* --------------------------------------------------------------- nudging -- */

/**
 * Arrow-key nudging, wrapped in one transaction per *gesture*.
 *
 * A held arrow key auto-repeats at roughly 30Hz. Applying each repeat as its
 * own edit would push thirty entries onto the undo stack for one continuous
 * slide, so undoing it would take thirty presses - the same bug a drag would
 * have without transactions, and the same fix: `beginTransaction` on the first
 * press, mutate freely while the key is down, `commitTransaction` when the last
 * arrow is released. The history layer's no-op guard means a press that moved
 * nothing leaves no entry at all.
 *
 * It cannot be a table row because a `Command` fires per keydown with no notion
 * of a key being *held*, which is precisely the state this needs to track.
 */
function createNudger(store: StoreApi<CanvasStore>) {
  const held = new Set<string>();
  let open = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const commit = (): void => {
    held.clear();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!open) return;
    open = false;
    store.getState().commitTransaction();
  };

  /**
   * The same question the pointer path asks, answered by the same function.
   *
   * The selection is not the thing that moves: a group's box is a cache over its
   * leaves, so patching the group is erased by `withDerivedGroups` inside the
   * same synchronous write - the nudge would move nothing *and* still cost an
   * undo entry, because the derive pass mints a fresh group object that
   * history's reference-equality guard cannot recognise as equivalent.
   * `gestureTargets` expands to the leaves and drops the effectively-locked
   * ones, which is exactly what a drag already does (`executeIntents.ts`).
   */
  const movable = (state: CanvasStore): readonly CanvasElement[] =>
    gestureTargets(state.elements, state.selection);

  const keyDown = (event: KeyboardEvent): boolean => {
    // No modifier combinations: Ctrl/Alt/Cmd + arrow belongs to the OS and the
    // browser (word-wise movement, history navigation, virtual desktops).
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const delta = ARROW_DELTAS[event.key.toLowerCase()];
    if (delta === undefined) return false;
    if (isTypingTarget(event.target)) return false;

    const state = store.getState();
    // Never while a dialog is up or a pointer gesture owns the document: the
    // interaction layer has its own transaction open and nudging inside it
    // would nest into a drag the user is still performing.
    if (state.activeDialog !== null || state.interaction.kind !== 'idle') return false;

    const elements = movable(state);
    if (elements.length === 0) return false;

    if (!open) {
      open = true;
      store.getState().beginTransaction('Move elements');
    }

    const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
    store
      .getState()
      .applyPatches(
        translateElements(elements, delta.x * step, delta.y * step),
        `Move ${elements.length === 1 ? '1 element' : `${elements.length} elements`}`
      );

    held.add(event.key.toLowerCase());
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(commit, NUDGE_IDLE_COMMIT_MS);
    return true;
  };

  const keyUp = (event: KeyboardEvent): void => {
    if (!open) return;
    held.delete(event.key.toLowerCase());
    // Only when every arrow is up: a diagonal nudge holds two keys and must
    // stay one undo entry.
    if (held.size === 0) commit();
  };

  return { keyDown, keyUp, commit };
}

/* ----------------------------------------------------------- default deps -- */

/**
 * Theme is read off the `data-theme` attribute rather than from `useTheme()`.
 * That attribute is the hook's own declared source of truth - it is set inline
 * in `index.html` before first paint - and reading it keeps these two callbacks
 * stable across renders, which is what stops the whole command table from being
 * rebuilt and re-registered on every theme change.
 */
function isDarkTheme(): boolean {
  return document.documentElement.dataset['theme'] === 'dark';
}

function toggleTheme(): void {
  setTheme(isDarkTheme() ? 'light' : 'dark');
}

/**
 * Opens a file picker for JSON import.
 *
 * A detached `<input type="file">` clicked programmatically, because there is
 * no other way to get a file dialog: `showOpenFilePicker` is Chromium-only. The
 * input is appended before the click - Safari ignores a click on a node that is
 * not in the document - and removed as soon as it has served its purpose.
 */
function pickJsonFile(onText: (text: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file === undefined) return;
    void file.text().then(onText);
  });
  document.body.appendChild(input);
  input.click();
}

function defaultDeps(): CommandDeps {
  return {
    store: useCanvasStore,
    clipboard,
    session: projectSession,
    openExport: (format: ExportFormat) => {
      setExportFormat(format);
      useCanvasStore.getState().openDialog('export');
    },
    importJson: () => {
      pickJsonFile((text) => {
        void projectSession.importJson(text);
      });
    },
    toggleTheme,
    isDarkTheme,
  };
}

/* ------------------------------------------------------------------ hook -- */

/**
 * Installs the table, the keyboard, and the paste bridge.
 *
 * Reference counted so that a second caller - or StrictMode's double mount -
 * cannot register the table twice (which the registry rejects outright) or
 * attach a second set of listeners.
 */
let installCount = 0;
let uninstall: (() => void) | null = null;

function install(): void {
  const registry = commandRegistry;
  const store: StoreApi<CanvasStore> = useCanvasStore;
  const disposeCommands = registry.registerAll(createCommands(defaultDeps()));
  const nudger = createNudger(store);

  const onKeyDown = (event: KeyboardEvent): void => {
    // Something closer to the source already claimed this key - an inline text
    // editor, a menu, a native control. Re-handling it here is how one keypress
    // ends up doing two things.
    if (event.defaultPrevented) return;

    if (nudger.keyDown(event)) {
      // Arrows scroll the page by default, which would slide the canvas out
      // from under the element being nudged.
      event.preventDefault();
      return;
    }

    if (registry.handleKeyDown(event)) {
      event.preventDefault();
      return;
    }

    // Backspace is an alias for Delete. The registry binds one chord per command
    // by design, so registering a second command for it would put a duplicate
    // "Delete" in the palette - the alias is resolved here instead.
    if (event.key !== 'Backspace' || isTypingTarget(event.target)) return;
    const remove = registry.get('edit.delete');
    if (remove === undefined || remove.isEnabled?.() === false) return;
    remove.run();
    event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    nudger.keyUp(event);
  };

  // A window that loses focus mid-hold never delivers the keyup, which would
  // leave a transaction open - and an open transaction blocks autosave and
  // refuses undo until something closes it.
  const onBlur = (): void => {
    nudger.commit();
  };

  /*
   * The promptless cross-tab paste path. `mod+v` is consumed above, and its
   * `preventDefault` suppresses the native paste event, so this fires only for
   * the Edit menu and the context menu - it cannot double up with the command.
   */
  const onPaste = (event: ClipboardEvent): void => {
    const state = store.getState();
    if (state.activeDialog !== null || isTypingTarget(event.target)) return;
    const result = clipboard.pasteFromEvent(event, {
      documentId: projectSession.getState().projectId,
      anchorWorld: viewportCenterWorld(store),
    });
    if (result === null) return;
    event.preventDefault();
    applyPastedElements(store, result, 'Paste');
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('paste', onPaste);
  window.addEventListener('blur', onBlur);

  uninstall = () => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('blur', onBlur);
    nudger.commit();
    disposeCommands();
  };
}

/**
 * Registers the command table and installs the editor's keyboard.
 *
 * Returns the registry so the toolbar and the palette can look commands up by
 * id instead of re-deriving what a button does.
 */
export function useCommands(): ShortcutRegistry {
  useEffect(() => {
    installCount += 1;
    if (installCount === 1) install();
    return () => {
      installCount -= 1;
      if (installCount > 0) return;
      uninstall?.();
      uninstall = null;
    };
  }, []);

  return commandRegistry;
}
