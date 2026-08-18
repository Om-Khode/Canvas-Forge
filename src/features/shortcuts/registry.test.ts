import { describe, expect, it, vi } from 'vitest';
import { createShortcutRegistry, isTypingTarget, type Command } from './registry';

function command(overrides: Partial<Command> & Pick<Command, 'id'>): Command {
  return {
    title: overrides.id,
    group: 'edit',
    run: vi.fn(),
    ...overrides,
  };
}

const keydown = (init: Partial<KeyboardEventInit> & { key: string }, target?: EventTarget) => {
  const event = new KeyboardEvent('keydown', init);
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
};

describe('shortcut registry', () => {
  it('runs the command bound to a chord', () => {
    const registry = createShortcutRegistry();
    const undo = command({ id: 'undo', shortcut: 'mod+z' });
    registry.register(undo);

    expect(registry.handleKeyDown(keydown({ key: 'z', ctrlKey: true }))).toBe(true);
    expect(undo.run).toHaveBeenCalledOnce();
  });

  it('distinguishes chords that differ only by shift', () => {
    const registry = createShortcutRegistry();
    const undo = command({ id: 'undo', shortcut: 'mod+z' });
    const redo = command({ id: 'redo', shortcut: 'mod+shift+z' });
    registry.registerAll([undo, redo]);

    registry.handleKeyDown(keydown({ key: 'z', ctrlKey: true, shiftKey: true }));

    expect(redo.run).toHaveBeenCalledOnce();
    expect(undo.run).not.toHaveBeenCalled();
  });

  it('reports an unbound chord as unhandled so the browser default survives', () => {
    const registry = createShortcutRegistry();
    expect(registry.handleKeyDown(keydown({ key: 'q' }))).toBe(false);
  });

  it('refuses to bind the same chord twice', () => {
    const registry = createShortcutRegistry();
    registry.register(command({ id: 'a', shortcut: 'mod+d' }));

    // A silently shadowed shortcut is a bug that only surfaces intermittently.
    expect(() => registry.register(command({ id: 'b', shortcut: 'mod+d' }))).toThrow(
      /already bound/
    );
  });

  it('refuses duplicate command ids', () => {
    const registry = createShortcutRegistry();
    registry.register(command({ id: 'dupe' }));
    expect(() => registry.register(command({ id: 'dupe' }))).toThrow(/Duplicate command/);
  });

  it('skips a disabled command and leaves the event unhandled', () => {
    const registry = createShortcutRegistry();
    const undo = command({ id: 'undo', shortcut: 'mod+z', isEnabled: () => false });
    registry.register(undo);

    expect(registry.handleKeyDown(keydown({ key: 'z', ctrlKey: true }))).toBe(false);
    expect(undo.run).not.toHaveBeenCalled();
  });

  it('unregisters cleanly, freeing the chord', () => {
    const registry = createShortcutRegistry();
    const dispose = registry.register(command({ id: 'a', shortcut: 'mod+d' }));
    dispose();

    expect(registry.get('a')).toBeUndefined();
    expect(() => registry.register(command({ id: 'b', shortcut: 'mod+d' }))).not.toThrow();
  });

  describe('while typing', () => {
    it('does not fire a bare-letter shortcut inside a text input', () => {
      const registry = createShortcutRegistry();
      const rectangle = command({ id: 'tool.rectangle', shortcut: 'r' });
      registry.register(rectangle);

      const input = document.createElement('input');
      expect(registry.handleKeyDown(keydown({ key: 'r' }, input))).toBe(false);
      expect(rectangle.run).not.toHaveBeenCalled();
    });

    it('fires when the command opts in', () => {
      const registry = createShortcutRegistry();
      const cancel = command({ id: 'cancel', shortcut: 'escape', allowWhileTyping: true });
      registry.register(cancel);

      const input = document.createElement('input');
      expect(registry.handleKeyDown(keydown({ key: 'Escape' }, input))).toBe(true);
    });
  });
});

describe('isTypingTarget', () => {
  it('recognises text-entry elements', () => {
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('input'))).toBe(true);

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });

  it('does not treat non-text inputs as typing', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(isTypingTarget(checkbox)).toBe(false);
  });

  it('ignores ordinary elements and null', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
