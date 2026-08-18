import { describe, expect, it } from 'vitest';
import type { TextElement } from '@/types';
import { fontString, measureTextBlock, wrapText, type TextMeasurer } from './text';

/**
 * A deterministic stand-in for canvas text metrics: every character is one unit
 * wide. jsdom has no 2D context, and a real one would make these assertions
 * depend on whichever font the machine happens to resolve - which is how text
 * tests become flaky across CI runners.
 */
const monospace: TextMeasurer = {
  measureText: (value: string) => ({ width: value.length }),
};

function textElement(overrides: Partial<TextElement> = {}): TextElement {
  return {
    id: 't1',
    type: 'text',
    name: 'Text',
    x: 0,
    y: 0,
    width: 10,
    height: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    text: 'hello world',
    fontFamily: 'sans-serif',
    fontSize: 20,
    fontWeight: 400,
    italic: false,
    textAlign: 'left',
    lineHeight: 1.5,
    color: '#000',
    autoHeight: true,
    ...overrides,
  };
}

describe('fontString', () => {
  it('emits style, weight, size, family in the order the canvas parser needs', () => {
    expect(fontString(textElement({ fontWeight: 700, fontSize: 24 }))).toBe(
      '700 24px sans-serif'
    );
  });

  it('prefixes italic', () => {
    expect(fontString(textElement({ italic: true }))).toBe('italic 400 20px sans-serif');
  });
});

describe('wrapText', () => {
  it('wraps greedily at spaces', () => {
    expect(wrapText(monospace, 'aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps a line that exactly fills the width', () => {
    expect(wrapText(monospace, 'aaa bbb', 7)).toEqual(['aaa bbb']);
  });

  it('honours hard newlines even when the text would fit', () => {
    expect(wrapText(monospace, 'ab\ncd', 100)).toEqual(['ab', 'cd']);
  });

  it('preserves blank lines between paragraphs', () => {
    expect(wrapText(monospace, 'a\n\nb', 100)).toEqual(['a', '', 'b']);
  });

  it('breaks inside a word too long to fit on its own line', () => {
    expect(wrapText(monospace, 'abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });

  it('flushes the current line before breaking an oversized word', () => {
    expect(wrapText(monospace, 'ab cdefgh', 3)).toEqual(['ab', 'cde', 'fgh']);
  });

  it('gives up on wrapping rather than looping when the width is zero', () => {
    expect(wrapText(monospace, 'anything at all', 0)).toEqual(['anything at all']);
  });

  it('returns one empty line for empty text', () => {
    expect(wrapText(monospace, '', 50)).toEqual(['']);
  });
});

describe('measureTextBlock', () => {
  it('derives line height from the font size multiplier, not an absolute', () => {
    const layout = measureTextBlock(monospace, textElement({ fontSize: 20, lineHeight: 1.5 }));
    expect(layout.lineHeightPx).toBe(30);
  });

  it('total height is line count times line height', () => {
    // width 5 forces 'hello world' to wrap into two lines.
    const layout = measureTextBlock(
      monospace,
      textElement({ width: 5, fontSize: 10, lineHeight: 2 })
    );
    expect(layout.lines).toEqual(['hello', 'world']);
    expect(layout.height).toBe(layout.lines.length * layout.lineHeightPx);
    expect(layout.height).toBe(40);
  });
});
