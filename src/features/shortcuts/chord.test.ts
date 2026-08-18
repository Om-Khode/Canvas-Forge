import { describe, expect, it } from 'vitest';
import { chordFromEvent, formatChord, normalizeChord, parseChord, serializeChord } from './chord';

describe('parseChord', () => {
  it('parses a bare key', () => {
    expect(parseChord('v')).toEqual({ mod: false, shift: false, alt: false, key: 'v' });
  });

  it('parses modifiers in any order and canonicalizes them', () => {
    expect(normalizeChord('shift+mod+z')).toBe('mod+shift+z');
    expect(normalizeChord('mod+shift+z')).toBe('mod+shift+z');
  });

  it('treats ctrl, cmd, and meta as the platform modifier', () => {
    for (const spelling of ['ctrl+a', 'cmd+a', 'meta+a', 'mod+a']) {
      expect(normalizeChord(spelling)).toBe('mod+a');
    }
  });

  it('expands human-friendly key aliases', () => {
    expect(parseChord('esc').key).toBe('escape');
    expect(parseChord('del').key).toBe('delete');
    expect(parseChord('up').key).toBe('arrowup');
    expect(parseChord('space').key).toBe(' ');
  });

  it('handles the literal plus key', () => {
    expect(parseChord('mod++')).toEqual({ mod: true, shift: false, alt: false, key: '+' });
  });

  it('rejects an unknown modifier rather than silently ignoring it', () => {
    expect(() => parseChord('hyper+z')).toThrow(/Unknown modifier/);
  });

  it('rejects an empty chord', () => {
    expect(() => parseChord('')).toThrow(/Invalid shortcut/);
  });
});

describe('serializeChord', () => {
  it('round-trips through parse', () => {
    for (const chord of ['mod+shift+alt+z', 'mod+k', 'escape', 'v']) {
      expect(serializeChord(parseChord(chord))).toBe(chord);
    }
  });
});

describe('chordFromEvent', () => {
  const event = (init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent =>
    new KeyboardEvent('keydown', init);

  it('reads the modifier state', () => {
    // navigator.platform in jsdom is not Apple, so ctrlKey is the platform modifier.
    expect(chordFromEvent(event({ key: 'z', ctrlKey: true }))).toEqual({
      mod: true,
      shift: false,
      alt: false,
      key: 'z',
    });
  });

  it('records shift on a letter, so redo does not collapse onto undo', () => {
    // Ctrl+Shift+Z arrives with key 'Z'. Lowercasing loses the shift, so the
    // flag has to be carried separately or redo becomes undo.
    expect(chordFromEvent(event({ key: 'Z', ctrlKey: true, shiftKey: true }))).toEqual({
      mod: true,
      shift: true,
      alt: false,
      key: 'z',
    });
  });

  it('records shift on non-printable keys', () => {
    expect(chordFromEvent(event({ key: 'Tab', shiftKey: true }))).toMatchObject({
      shift: true,
      key: 'tab',
    });
  });

  it('records shift on punctuation too, matching what the event reports', () => {
    expect(chordFromEvent(event({ key: '?', shiftKey: true }))).toMatchObject({
      shift: true,
      key: '?',
    });
  });

  it('lowercases the key so Z and z are the same chord', () => {
    expect(chordFromEvent(event({ key: 'Z', ctrlKey: true })).key).toBe('z');
  });
});

describe('formatChord', () => {
  it('renders a readable label', () => {
    // jsdom reports a non-Apple platform, so the Windows/Linux form is expected.
    expect(formatChord('mod+shift+z')).toBe('Ctrl+Shift+Z');
    expect(formatChord('escape')).toBe('Esc');
    expect(formatChord('v')).toBe('V');
  });
});
