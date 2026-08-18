import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { fontString } from '@/features/canvas/engine/drawers';
import { useInteraction } from '@/store';
import type { ElementId } from '@/types';
import { useTextEditing } from './useTextEditing';

/**
 * The caret the canvas cannot provide.
 *
 * A `<textarea>` positioned over the element being edited, in *screen* space,
 * derived from the element's world rect and the live viewport - so it tracks
 * pan and zoom while it is open. The metrics that make it line up with the
 * painted text live in `useTextEditing`; this file is the markup and the
 * keyboard.
 *
 * The nesting is load-bearing rather than decorative:
 *
 *   positioner   left/top = the element's top-left in screen px, scale(zoom)
 *     rotator    rotate(rotation) about its own centre - the same order the
 *                renderer's element matrix applies
 *       textarea sized and typeset in *world* units
 *
 * Because the scale is applied to the whole box, the browser lays the text out
 * against `element.width` at `element.fontSize` - exactly the numbers
 * `wrapText` will be handed in the renderer - and the zoom is a pure visual
 * transform on top. There is no zoom-dependent rounding to disagree about.
 *
 * The component splits in two so that **nothing subscribes to the viewport or
 * the document while no edit is open**: the outer half watches one field that
 * changes on a double-click, and the inner half - which re-renders on every pan
 * and every keystroke - only exists while a caret does.
 */
export function TextEditorOverlay() {
  const interaction = useInteraction();
  if (interaction.kind !== 'editing-text') return null;
  return <TextEditorBox elementId={interaction.elementId} />;
}

interface TextEditorBoxProps {
  readonly elementId: ElementId;
}

function TextEditorBox({ elementId }: TextEditorBoxProps) {
  const session = useTextEditing(elementId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.focus({ preventScroll: true });
    // Caret at the end rather than a select-all: with the whole paragraph
    // selected, the first keystroke of someone who meant to append silently
    // replaces everything they wrote.
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, [elementId]);

  // The element was deleted from under the editor; the session has already
  // closed its transaction.
  if (session === null) return null;
  const { element, box, setText, finish } = session;

  const positioner: CSSProperties = {
    left: box.screen.x,
    top: box.screen.y,
    transform: `scale(${box.zoom})`,
    transformOrigin: '0 0',
  };

  const rotator: CSSProperties = {
    width: box.width,
    height: box.height,
    transform: `rotate(${box.rotation}rad)`,
    transformOrigin: '50% 50%',
  };

  const type: CSSProperties = {
    // The single source of truth for the typeface, shared with the drawer:
    // `fontString` produces `[italic] weight size family`, which is a valid CSS
    // font shorthand as well as a valid canvas one.
    font: fontString(element),
    // Unitless, so it means the same multiple of the font size the renderer
    // uses for its baseline spacing. It **must** stay after `font`: the CSS
    // shorthand resets line-height to `normal`, so declaring it first would
    // leave the DOM leading at the font's default while the canvas used 1.35.
    lineHeight: element.lineHeight,
    color: element.color,
    textAlign: element.textAlign,
    // Spelled out rather than left to the UA stylesheet, because these two are
    // what make the browser's line breaking agree with `wrapText`: newlines are
    // honoured verbatim, and a word wider than the box is broken inside itself
    // instead of overflowing (`splitOversizedWord` does the same on canvas).
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  };

  return (
    <div className="absolute" style={positioner}>
      <div style={rotator}>
        <textarea
          ref={textareaRef}
          /*
            Every default a textarea brings - padding, border, resize grip,
            background - would offset the glyphs from where the canvas puts
            them, so all of them are removed. `outline-none` is safe here and
            nowhere else in the app: the element stays selected while it is
            being edited, so the renderer's own selection frame is drawn around
            this exact box and is the focus indicator. Painting a second ring
            in the DOM would double the stroke.
          */
          className="block h-full w-full resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
          style={type}
          value={element.text}
          aria-label={`Text content of ${element.name}`}
          // A textarea is spellchecked and autocapitalised like prose by
          // default; a design canvas label is neither.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={finish}
          onKeyDown={(event) => {
            // Enter inserts a newline. This is a text box, not a form field -
            // the only key that ends the edit is Escape.
            if (event.key !== 'Escape') return;
            // Escape *commits*. Reverting a paragraph because someone reached
            // for Escape is hostile, and there is a real undo one keystroke
            // away if they wanted the old text back.
            finish();
            // Stops the app-root handler acting on the same keypress, but
            // deliberately does not stop propagation: the pointer machine's
            // window listener has to see it too, or its `editing-text` state
            // would outlive the caret.
            event.preventDefault();
          }}
        />
      </div>
    </div>
  );
}
