import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fontString } from '@/features/canvas/engine/drawers';
import { executeIntents } from '@/features/canvas/interaction/executeIntents';
import { resetCanvasStore, useCanvasStore } from '@/store';
import type { TextElement } from '@/types';
import { TextEditorOverlay } from './TextEditorOverlay';
import { autoHeightFor } from './useTextEditing';

/**
 * What these tests defend, in order of how expensive the bug would be:
 *
 *  1. The overlay and the renderer agree on the typeface. A mismatch between
 *     the editing state and the committed state is the single most obvious way
 *     this feature looks amateur, and it is invisible in a unit test unless the
 *     *same* `fontString` is asserted on both sides.
 *  2. The whole edit is one undo entry. A transaction that leaks one entry per
 *     keystroke is not visible until someone tries to undo a paragraph.
 *  3. The element is hidden while editing and visible afterwards - the trick
 *     that keeps the text from being painted twice must not survive the edit.
 */

const ELEMENT_ID = 'text-1';

function textElement(overrides: Partial<TextElement> = {}): TextElement {
  return {
    id: ELEMENT_ID,
    type: 'text',
    name: 'Text 1',
    x: 100,
    y: 50,
    width: 200,
    height: 27,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    text: 'hello',
    fontFamily: 'Inter, sans-serif',
    fontSize: 20,
    fontWeight: 400,
    italic: false,
    textAlign: 'left',
    lineHeight: 1.35,
    color: '#1c1c1f',
    autoHeight: true,
    ...overrides,
  };
}

function startEditing(element: TextElement = textElement()): void {
  act(() => {
    const store = useCanvasStore.getState();
    store.addElement(element);
    store.select([element.id]);
    store.setInteraction({ kind: 'editing-text', elementId: element.id });
  });
}

function editor(): HTMLTextAreaElement {
  return screen.getByRole('textbox');
}

/**
 * The typeface the browser actually resolved, rebuilt in `fontString`'s own
 * `[style] weight size family` order.
 *
 * Read back through the longhands rather than through `style.font` because the
 * CSS shorthand serializes the line-height into itself (`20px / 1.35`) while
 * the canvas shorthand has no such slot. Comparing the parts proves the DOM
 * parsed our declaration into exactly the components the canvas parser will.
 */
function resolvedFont(textarea: HTMLTextAreaElement): string {
  const { fontStyle, fontWeight, fontSize, fontFamily } = textarea.style;
  const italic = fontStyle === 'italic' ? 'italic ' : '';
  return `${italic}${fontWeight} ${fontSize} ${fontFamily}`;
}

function currentText(): TextElement | undefined {
  const element = useCanvasStore.getState().elements.byId[ELEMENT_ID];
  return element?.type === 'text' ? element : undefined;
}

function historyLength(): number {
  return useCanvasStore.getState().history.past.length;
}

describe('TextEditorOverlay', () => {
  beforeEach(() => {
    resetCanvasStore();
  });

  it('renders nothing while no edit is open', () => {
    render(<TextEditorOverlay />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  /**
   * The text tool's path in, driven exactly the way `usePointerInteraction`
   * drives it: run the batch of intents the machine emitted on pointerup, then
   * mirror the machine's resulting state - which is `idle`, because the *draw*
   * gesture is over - into the store. A `beginTextEdit` that wrote the editing
   * state synchronously would be erased by that mirror and the caret would
   * never appear, which is invisible to a test that only sets the state itself.
   */
  it('opens when the text tool commits a fresh draft', async () => {
    act(() => {
      useCanvasStore.getState().addElement(textElement({ text: '' }));
    });
    render(<TextEditorOverlay />);

    await act(async () => {
      executeIntents([{ kind: 'commitDraft' }, { kind: 'beginTextEdit', elementId: null }], {
        snapshot: { current: null },
        draftId: { current: ELEMENT_ID },
      });
      useCanvasStore.getState().setInteraction({ kind: 'idle' });
      // The editor opens one microtask after the mirror, deliberately - see
      // `openTextEditor` in executeIntents. This is that microtask.
      await Promise.resolve();
    });

    expect(useCanvasStore.getState().interaction).toEqual({
      kind: 'editing-text',
      elementId: ELEMENT_ID,
    });
    expect(editor()).toHaveValue('');
    expect(useCanvasStore.getState().selection.has(ELEMENT_ID)).toBe(true);
  });

  it('is a real focusable control with an accessible name', () => {
    startEditing();
    render(<TextEditorOverlay />);

    const textarea = editor();
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAccessibleName('Text content of Text 1');
    expect(textarea).toHaveFocus();
    expect(textarea.value).toBe('hello');
  });

  it('typesets itself with the drawer’s own font string', () => {
    const element = textElement({ italic: true, fontWeight: 700, fontSize: 32 });
    startEditing(element);
    render(<TextEditorOverlay />);

    // The assertion that matters: not "a font is set" but "the *same* font the
    // renderer will paint with", built by the same function.
    expect(resolvedFont(editor())).toBe(fontString(element));
    expect(resolvedFont(editor())).toBe('italic 700 32px Inter, sans-serif');
    // The leading has to survive too: the CSS `font` shorthand resets
    // line-height, so the declaration that follows it is what keeps the DOM's
    // baseline spacing equal to `lineHeight * fontSize` on the canvas.
    expect(editor().style.lineHeight).toBe('1.35');
  });

  it('positions itself over the element in screen space and follows the viewport', () => {
    startEditing();
    render(<TextEditorOverlay />);

    const positioner = editor().parentElement?.parentElement;
    // world (100, 50) at pan (0,0), zoom 1.
    expect(positioner).toHaveStyle({ left: '100px', top: '50px', transform: 'scale(1)' });

    act(() => {
      useCanvasStore.getState().setViewport({ panX: 40, panY: 10, zoom: 2 });
    });

    // world (100, 50) * 2 + (40, 10). The box keeps its *world* size and is
    // scaled, so the glyphs match the canvas at any zoom.
    expect(positioner).toHaveStyle({ left: '240px', top: '110px', transform: 'scale(2)' });
    expect(resolvedFont(editor())).toBe(fontString(textElement()));
  });

  it('hides the canvas copy while editing and restores it on commit', () => {
    startEditing();
    render(<TextEditorOverlay />);
    expect(currentText()?.visible).toBe(false);

    fireEvent.change(editor(), { target: { value: 'hello world' } });
    fireEvent.blur(editor());

    expect(currentText()?.visible).toBe(true);
    expect(currentText()?.text).toBe('hello world');
  });

  it('records the whole edit as one undo entry', () => {
    startEditing();
    const before = historyLength();
    render(<TextEditorOverlay />);

    // Six store writes: five keystrokes plus the hide.
    for (const value of ['h', 'he', 'hel', 'hell', 'hello!']) {
      fireEvent.change(editor(), { target: { value } });
    }
    fireEvent.blur(editor());

    expect(historyLength()).toBe(before + 1);
    expect(useCanvasStore.getState().history.past.at(-1)?.label).toBe('Edit text');

    act(() => {
      useCanvasStore.getState().undo();
    });
    expect(currentText()?.text).toBe('hello');
    expect(currentText()?.visible).toBe(true);
  });

  it('leaves no undo entry when nothing was typed', () => {
    startEditing();
    const before = historyLength();
    render(<TextEditorOverlay />);
    fireEvent.blur(editor());

    expect(historyLength()).toBe(before);
    expect(currentText()?.visible).toBe(true);
  });

  it('commits on Escape rather than reverting what was typed', () => {
    startEditing();
    render(<TextEditorOverlay />);

    fireEvent.change(editor(), { target: { value: 'kept' } });
    fireEvent.keyDown(editor(), { key: 'Escape' });

    expect(currentText()?.text).toBe('kept');
    expect(useCanvasStore.getState().interaction.kind).toBe('idle');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('treats Enter as a newline, not as a commit', () => {
    startEditing();
    render(<TextEditorOverlay />);

    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(useCanvasStore.getState().interaction.kind).toBe('editing-text');
    expect(screen.queryByRole('textbox')).not.toBeNull();

    // The browser inserts the newline itself; what matters is that it survives
    // the round trip through the store rather than being trimmed away.
    fireEvent.change(editor(), { target: { value: 'one\ntwo' } });
    fireEvent.blur(editor());
    expect(currentText()?.text).toBe('one\ntwo');
  });

  it('deletes a text element that was left empty', () => {
    startEditing();
    render(<TextEditorOverlay />);

    fireEvent.change(editor(), { target: { value: '' } });
    fireEvent.blur(editor());

    expect(currentText()).toBeUndefined();
    expect(useCanvasStore.getState().elements.order).not.toContain(ELEMENT_ID);
  });

  it('closes its transaction when the element disappears mid-edit', () => {
    startEditing();
    const { unmount } = render(<TextEditorOverlay />);

    act(() => {
      useCanvasStore.getState().removeElements([ELEMENT_ID]);
    });
    unmount();

    // An open transaction would block autosave and refuse undo forever.
    expect(useCanvasStore.getState().history.depth).toBe(0);
    // And the deletion stands - closing the edit must not resurrect it.
    expect(currentText()).toBeUndefined();
  });

  it('ends the edit on a window blur, before autosave can see the hidden flag', () => {
    startEditing();
    render(<TextEditorOverlay />);
    fireEvent.change(editor(), { target: { value: 'typed' } });

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(currentText()?.visible).toBe(true);
    expect(currentText()?.text).toBe('typed');
    expect(useCanvasStore.getState().history.depth).toBe(0);
  });
});

describe('autoHeightFor', () => {
  /** A measurer with a fixed advance width per character - no canvas needed. */
  const measurer = { measureText: (text: string) => ({ width: text.length * 10 }) };

  it('grows the box to the wrapped content', () => {
    // 200px wide at 10px per character wraps "aaaa bbbb cccc" into two lines.
    const element = textElement({ width: 100, text: 'aaaa bbbb cccc' });
    expect(autoHeightFor(element, measurer)).toBeCloseTo(2 * 20 * 1.35, 5);
  });

  it('never collapses below a single line', () => {
    expect(autoHeightFor(textElement({ text: '', height: 999 }), measurer)).toBeCloseTo(
      20 * 1.35,
      5
    );
  });

  it('returns null when the height is already right, so no store write happens', () => {
    const element = textElement({ text: 'short', height: 20 * 1.35 });
    expect(autoHeightFor(element, measurer)).toBeNull();
  });

  it('leaves a manually-resized box alone', () => {
    const element = textElement({ autoHeight: false, height: 500, text: 'a b c d e f g' });
    expect(autoHeightFor(element, measurer)).toBeNull();
  });

  it('does nothing where nothing can measure text', () => {
    expect(autoHeightFor(textElement(), null)).toBeNull();
  });
});
