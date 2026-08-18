import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommands, type CommandDeps } from './createCommands';
import { createClipboard } from './clipboard';
import { createRectangle } from '@/features/elements/factory';
import { createShortcutRegistry } from '@/features/shortcuts/registry';
import type { Command } from '@/features/shortcuts/registry';
import type { ProjectSession } from '@/features/project/useProjectSession';
import { resetCanvasStore, useCanvasStore } from '@/store';
import type { CanvasElement, WorldRect } from '@/types';
import { viewportToFit } from '@/utils/coords';

function rect(x: number, y: number, width: number, height: number): WorldRect {
  return { x, y, width, height } as WorldRect;
}

const session = {
  getState: () => ({
    status: 'ready' as const,
    projectId: 'project-1',
    warnings: [],
    error: null,
    persistent: true,
  }),
  newProject: vi.fn(),
  saveNow: vi.fn(),
  duplicateProject: vi.fn(),
  openDemo: vi.fn(),
} as unknown as ProjectSession;

function build(overrides: Partial<CommandDeps> = {}): Map<string, Command> {
  const deps: CommandDeps = {
    store: useCanvasStore,
    clipboard: createClipboard({ system: null }),
    session,
    openExport: vi.fn(),
    importJson: vi.fn(),
    toggleTheme: vi.fn(),
    isDarkTheme: () => false,
    ...overrides,
  };
  return new Map(createCommands(deps).map((command) => [command.id, command]));
}

function seed(...elements: CanvasElement[]): void {
  useCanvasStore.getState().addElements(elements);
}

beforeEach(() => {
  resetCanvasStore();
});

describe('the command table', () => {
  it('registers whole without a duplicate id or chord', () => {
    // The registry throws on either, deliberately, so this test is the guard
    // against a new row silently shadowing an existing shortcut.
    const commands = [...build().values()];
    expect(() => createShortcutRegistry().registerAll(commands)).not.toThrow();
  });

  it('binds the shortcuts the spec names', () => {
    const chords = new Map(
      [...build().values()]
        .filter((command) => command.shortcut !== undefined)
        .map((command) => [command.shortcut, command.id])
    );

    expect(chords.get('v')).toBe('tool.select');
    expect(chords.get('r')).toBe('tool.rectangle');
    expect(chords.get('o')).toBe('tool.ellipse');
    expect(chords.get('l')).toBe('tool.line');
    expect(chords.get('a')).toBe('tool.arrow');
    expect(chords.get('p')).toBe('tool.freehand');
    expect(chords.get('t')).toBe('tool.text');
    expect(chords.get('h')).toBe('tool.hand');
    expect(chords.get('delete')).toBe('edit.delete');
    expect(chords.get('mod+z')).toBe('edit.undo');
    expect(chords.get('mod+shift+z')).toBe('edit.redo');
    expect(chords.get('mod+c')).toBe('edit.copy');
    expect(chords.get('mod+v')).toBe('edit.paste');
    expect(chords.get('mod+x')).toBe('edit.cut');
    expect(chords.get('mod+a')).toBe('edit.select-all');
    expect(chords.get('mod+d')).toBe('edit.duplicate');
    expect(chords.get('mod+g')).toBe('edit.group');
    expect(chords.get('mod+shift+g')).toBe('edit.ungroup');
    expect(chords.get('mod+k')).toBe('palette.open');
    expect(chords.get('escape')).toBe('edit.clear-selection');
  });

  it('covers all nine tools', () => {
    const tools = [...build().keys()].filter((id) => id.startsWith('tool.'));
    expect(tools).toHaveLength(9);
  });
});

describe('isEnabled', () => {
  it('disables undo and redo until there is history', () => {
    const commands = build();
    expect(commands.get('edit.undo')?.isEnabled?.()).toBe(false);
    expect(commands.get('edit.redo')?.isEnabled?.()).toBe(false);

    seed(createRectangle(rect(0, 0, 10, 10)));
    expect(commands.get('edit.undo')?.isEnabled?.()).toBe(true);

    useCanvasStore.getState().undo();
    expect(commands.get('edit.redo')?.isEnabled?.()).toBe(true);
  });

  it('disables the selection commands until something is selected', () => {
    const commands = build();
    const element = createRectangle(rect(0, 0, 10, 10));
    seed(element);

    expect(commands.get('edit.copy')?.isEnabled?.()).toBe(false);
    expect(commands.get('edit.delete')?.isEnabled?.()).toBe(false);

    useCanvasStore.getState().select([element.id]);
    expect(commands.get('edit.copy')?.isEnabled?.()).toBe(true);
    expect(commands.get('edit.delete')?.isEnabled?.()).toBe(true);
  });

  it('refuses to delete a locked element', () => {
    const commands = build();
    const element = createRectangle(rect(0, 0, 10, 10));
    seed({ ...element, locked: true });
    useCanvasStore.getState().select([element.id]);

    // Selectable (so it can be unlocked) but not editable.
    expect(commands.get('edit.copy')?.isEnabled?.()).toBe(true);
    expect(commands.get('edit.delete')?.isEnabled?.()).toBe(false);
  });

  it('declines Escape while a dialog is open, so the dialog gets the key', () => {
    const commands = build();
    const element = createRectangle(rect(0, 0, 10, 10));
    seed(element);
    useCanvasStore.getState().select([element.id]);
    expect(commands.get('edit.clear-selection')?.isEnabled?.()).toBe(true);

    useCanvasStore.getState().openDialog('export');
    expect(commands.get('edit.clear-selection')?.isEnabled?.()).toBe(false);
  });

  it('disables zoom-to-fit and the raster exports on an empty document', () => {
    const commands = build();
    expect(commands.get('view.zoom-fit')?.isEnabled?.()).toBe(false);
    expect(commands.get('export.png')?.isEnabled?.()).toBe(false);
    // JSON of an empty project is still a legitimate file.
    expect(commands.get('export.json')?.isEnabled?.()).toBeUndefined();
  });
});

describe('a lock inside a group', () => {
  /**
   * `[locked, loose]` grouped together, with a third ungrouped rectangle. The
   * group itself is unlocked - grouping deliberately does not consult locks -
   * so its own `locked` flag says nothing about what deleting it would destroy.
   */
  function lockedInsideGroup(): { groupId: string; lockedId: string; looseId: string } {
    const member = createRectangle(rect(0, 0, 10, 10));
    const sibling = createRectangle(rect(20, 0, 10, 10));
    const loose = createRectangle(rect(40, 0, 10, 10));
    seed({ ...member, locked: true }, sibling, loose);
    const groupId = useCanvasStore.getState().group([member.id, sibling.id]);
    if (groupId === null) throw new Error('grouping failed');
    return { groupId, lockedId: member.id, looseId: loose.id };
  }

  it('refuses Delete on the group, because the delete would take the locked member with it', () => {
    const commands = build();
    const { groupId, lockedId } = lockedInsideGroup();
    useCanvasStore.getState().select([groupId]);

    // `removeElements` expands an id to its whole subtree, so there is no
    // per-member escape here the way there is for a drag: the group is exactly
    // as deletable as its contents. Lock → Ctrl+G → Delete was otherwise a
    // one-gesture route around the app's only protection primitive.
    expect(commands.get('edit.delete')?.isEnabled?.()).toBe(false);
    commands.get('edit.delete')?.run();
    expect(useCanvasStore.getState().elements.byId[lockedId]).toBeDefined();
    expect(useCanvasStore.getState().elements.byId[groupId]).toBeDefined();
  });

  it('refuses Cut on the group, and puts nothing on the clipboard', () => {
    const clipboard = createClipboard({ system: null });
    const commands = build({ clipboard });
    const { groupId, lockedId } = lockedInsideGroup();
    useCanvasStore.getState().select([groupId]);

    expect(commands.get('edit.cut')?.isEnabled?.()).toBe(false);
    commands.get('edit.cut')?.run();
    expect(useCanvasStore.getState().elements.byId[lockedId]).toBeDefined();
    expect(clipboard.canPaste()).toBe(false);
  });

  it('still deletes the rest of a mixed selection', () => {
    const commands = build();
    const { groupId, looseId } = lockedInsideGroup();
    useCanvasStore.getState().select([groupId, looseId]);

    // Same rule a locked *loose* element already followed: the protected thing
    // stays, everything else goes. Refusing the whole command would make one
    // locked leaf veto an unrelated delete.
    expect(commands.get('edit.delete')?.isEnabled?.()).toBe(true);
    commands.get('edit.delete')?.run();
    expect(useCanvasStore.getState().elements.byId[looseId]).toBeUndefined();
    expect(useCanvasStore.getState().elements.byId[groupId]).toBeDefined();
  });

  it('deletes a group whose members are all unlocked', () => {
    const commands = build();
    const { groupId, lockedId } = lockedInsideGroup();
    useCanvasStore.getState().toggleLocked(lockedId);
    useCanvasStore.getState().select([groupId]);

    expect(commands.get('edit.delete')?.isEnabled?.()).toBe(true);
    commands.get('edit.delete')?.run();
    expect(useCanvasStore.getState().elements.byId[groupId]).toBeUndefined();
    expect(useCanvasStore.getState().elements.byId[lockedId]).toBeUndefined();
  });

  it('refuses to delete a member selected inside a locked group', () => {
    const commands = build();
    const member = createRectangle(rect(0, 0, 10, 10));
    const sibling = createRectangle(rect(20, 0, 10, 10));
    seed(member, sibling);
    const groupId = useCanvasStore.getState().group([member.id, sibling.id]);
    if (groupId === null) throw new Error('grouping failed');
    useCanvasStore.getState().toggleLocked(groupId);
    // The layers panel can select a member of a locked group directly; the lock
    // is on the ancestor and nowhere on the member itself.
    useCanvasStore.getState().select([member.id]);

    expect(commands.get('edit.delete')?.isEnabled?.()).toBe(false);
  });
});

describe('zoom to fit, with groups in the document', () => {
  /** A group holding one visible rect at the origin and one hidden one far away. */
  function groupWithHiddenMember(): void {
    const shown = createRectangle(rect(0, 0, 200, 200));
    const away = createRectangle(rect(2000, 2000, 200, 200));
    seed(shown, away);
    const groupId = useCanvasStore.getState().group([shown.id, away.id]);
    if (groupId === null) throw new Error('grouping failed');
    useCanvasStore.getState().toggleVisible(away.id);
    useCanvasStore.getState().setViewportSize(800, 600);
  }

  it('frames what paints, not the group’s cached box', () => {
    groupWithHiddenMember();
    build().get('view.zoom-fit')?.run();

    // The group's own box spans the hidden member too - the store derives it
    // from every descendant - so a fit that measured the container would frame
    // 2,200 units of mostly nothing.
    expect(useCanvasStore.getState().viewport).toEqual(
      viewportToFit({ x: 0, y: 0, width: 200, height: 200 }, 800, 600)
    );
  });
});

describe('select all', () => {
  it('selects the group, not its members', () => {
    // Not the same defect as the fits above, and deliberately *not* fixed the
    // same way: selection resolves to the outermost group, so root ids are
    // exactly the right answer here. Pinned so a future sweep over
    // `elementsInOrder` call sites does not "fix" this one too.
    const a = createRectangle(rect(0, 0, 10, 10));
    const b = createRectangle(rect(40, 40, 10, 10));
    seed(a, b);
    const groupId = useCanvasStore.getState().group([a.id, b.id]);

    build().get('edit.select-all')?.run();

    expect([...useCanvasStore.getState().selection]).toEqual([groupId]);
  });
});

describe('running commands', () => {
  it('selects a tool and reports it active', () => {
    const commands = build();
    commands.get('tool.ellipse')?.run();

    expect(useCanvasStore.getState().tool).toBe('ellipse');
    expect(commands.get('tool.ellipse')?.isActive?.()).toBe(true);
    expect(commands.get('tool.select')?.isActive?.()).toBe(false);
  });

  it('deletes the selection as one undo entry', () => {
    const commands = build();
    const a = createRectangle(rect(0, 0, 10, 10));
    const b = createRectangle(rect(20, 0, 10, 10));
    seed(a, b);
    useCanvasStore.getState().select([a.id, b.id]);

    commands.get('edit.delete')?.run();
    expect(useCanvasStore.getState().elements.order).toHaveLength(0);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().elements.order).toHaveLength(2);
  });

  it('copies then pastes fresh elements and selects the copies', () => {
    const clipboard = createClipboard({ system: null });
    const commands = build({ clipboard });
    const element = createRectangle(rect(0, 0, 10, 10));
    seed(element);
    useCanvasStore.getState().select([element.id]);

    commands.get('edit.copy')?.run();
    commands.get('edit.paste')?.run();

    const state = useCanvasStore.getState();
    expect(state.elements.order).toHaveLength(2);
    expect(state.selection.size).toBe(1);
    expect(state.selection.has(element.id)).toBe(false);
  });

  it('duplicates without touching the clipboard', () => {
    const clipboard = createClipboard({ system: null });
    const commands = build({ clipboard });
    const element = createRectangle(rect(0, 0, 10, 10));
    seed(element);
    useCanvasStore.getState().select([element.id]);

    commands.get('edit.duplicate')?.run();

    expect(useCanvasStore.getState().elements.order).toHaveLength(2);
    expect(clipboard.isEmpty()).toBe(true);
  });

  it('groups the selection, selects the group, and ungroups it again', () => {
    const commands = build();
    const a = createRectangle(rect(0, 0, 10, 10));
    const b = createRectangle(rect(40, 40, 10, 10));
    seed(a, b);
    useCanvasStore.getState().select([a.id, b.id]);

    commands.get('edit.group')?.run();

    const grouped = useCanvasStore.getState();
    expect(grouped.elements.order).toHaveLength(1);
    expect(grouped.selection.size).toBe(1);
    expect(commands.get('edit.ungroup')?.isEnabled?.()).toBe(true);

    commands.get('edit.ungroup')?.run();

    const ungrouped = useCanvasStore.getState();
    expect(ungrouped.elements.order).toEqual([a.id, b.id]);
    // The freed members are what the user is now holding.
    expect([...ungrouped.selection].sort()).toEqual([a.id, b.id].sort());
  });

  it('offers Group only for a selection that can actually be grouped', () => {
    const commands = build();
    const a = createRectangle(rect(0, 0, 10, 10));
    const b = createRectangle(rect(40, 40, 10, 10));
    seed(a, b);

    expect(commands.get('edit.group')?.isEnabled?.()).toBe(false);
    expect(commands.get('edit.ungroup')?.isEnabled?.()).toBe(false);

    useCanvasStore.getState().select([a.id]);
    expect(commands.get('edit.group')?.isEnabled?.()).toBe(false);

    useCanvasStore.getState().select([a.id, b.id]);
    expect(commands.get('edit.group')?.isEnabled?.()).toBe(true);
  });

  it('duplicates a group together with its members', () => {
    const commands = build();
    const a = createRectangle(rect(0, 0, 10, 10));
    const b = createRectangle(rect(40, 40, 10, 10));
    seed(a, b);
    useCanvasStore.getState().select([a.id, b.id]);
    commands.get('edit.group')?.run();
    const groupId = [...useCanvasStore.getState().selection][0];

    commands.get('edit.duplicate')?.run();

    const state = useCanvasStore.getState();
    // Two groups at the root, four rectangles inside them, and the copy owns
    // members of its own rather than the original's.
    expect(state.elements.order).toHaveLength(2);
    expect(Object.keys(state.elements.byId)).toHaveLength(6);
    const copyId = [...state.selection][0];
    const copy = state.elements.byId[copyId ?? ''];
    const original = state.elements.byId[groupId ?? ''];
    expect(copy?.type).toBe('group');
    expect(copy?.type === 'group' ? copy.childIds : []).not.toEqual(
      original?.type === 'group' ? original.childIds : []
    );
  });

  it('copies a group across documents without stealing the original members', () => {
    const clipboard = createClipboard({ system: null });
    // A mutable projectId, switched between the copy and the paste, is what
    // actually drives `placeForPaste` down the cross-document branch - a fixed
    // id would take the same-document path and this test would exercise that
    // instead of what its name promises.
    let projectId = 'project-1';
    const crossDocumentSession: ProjectSession = {
      ...session,
      getState: () => ({ ...session.getState(), projectId }),
    };
    const commands = build({ clipboard, session: crossDocumentSession });
    const a = createRectangle(rect(0, 0, 10, 10));
    const b = createRectangle(rect(40, 40, 10, 10));
    seed(a, b);
    useCanvasStore.getState().select([a.id, b.id]);
    commands.get('edit.group')?.run();

    commands.get('edit.copy')?.run();
    projectId = 'project-2';
    commands.get('edit.paste')?.run();

    const state = useCanvasStore.getState();
    expect(state.elements.order).toHaveLength(2);
    // The originals are still where they were, still owned by the first group.
    expect(state.elements.byId[a.id]).toBeDefined();
    expect(state.selection.size).toBe(1);
  });

  it('toggles panels and reports their state', () => {
    const commands = build();
    expect(commands.get('view.toggle-layers')?.isActive?.()).toBe(true);

    commands.get('view.toggle-layers')?.run();
    expect(useCanvasStore.getState().panels.layers).toBe(false);
    expect(commands.get('view.toggle-layers')?.isActive?.()).toBe(false);
  });

  it('opens the export dialog with the requested format', () => {
    const openExport = vi.fn();
    build({ openExport }).get('export.svg')?.run();

    expect(openExport).toHaveBeenCalledWith('svg');
  });
});
