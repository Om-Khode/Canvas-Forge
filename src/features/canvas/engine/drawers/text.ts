import type { TextAlign, TextElement } from '@/types';
import type { Drawer } from './shared';

/**
 * The subset of the 2D context that wrapping needs.
 *
 * Narrowing the parameter to this makes the layout logic testable without a
 * real canvas - jsdom has no 2D context at all - and makes it obvious that
 * wrapping reads font metrics and nothing else. The caller is responsible for
 * having set `ctx.font` first; measurement is meaningless otherwise.
 */
export interface TextMeasurer {
  measureText(text: string): { readonly width: number };
}

export interface TextLayout {
  readonly lines: readonly string[];
  /** Distance between baselines, in local units. */
  readonly lineHeightPx: number;
  /** Total block height. What `autoHeight` elements resize themselves to. */
  readonly height: number;
}

/**
 * CSS shorthand in the order the canvas parser expects:
 * `[style] [weight] [size] [family]`. Any other order is silently ignored and
 * leaves the context on its default 10px sans-serif, which is the classic
 * "why is my canvas text tiny" bug.
 */
export function fontString(element: TextElement): string {
  const style = element.italic ? 'italic ' : '';
  return `${style}${element.fontWeight} ${element.fontSize}px ${element.fontFamily}`;
}

/**
 * Greedy word wrap. One pass, take words while they fit, break when they don't.
 *
 * Greedy rather than a minimum-raggedness (Knuth–Plass) pass: optimal wrapping
 * is O(n²) over a paragraph and re-runs on every keystroke while editing, and
 * the difference is invisible in a design tool's short labels. Documented as a
 * choice rather than left implicit.
 *
 * Hard newlines are honoured first so they always break, then each paragraph is
 * wrapped independently - otherwise a blank line between paragraphs would be
 * absorbed as whitespace and the user's spacing would vanish.
 */
export function wrapText(
  measurer: TextMeasurer,
  text: string,
  maxWidth: number
): readonly string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0 || maxWidth <= 0) {
      lines.push(paragraph);
      continue;
    }

    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (measurer.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current !== '') lines.push(current);

      // A single word wider than the box can't be fixed by breaking at spaces,
      // so fall back to breaking inside it. Without this the glyphs run outside
      // the element's bounds and no longer match its hit box.
      const pieces = splitOversizedWord(measurer, word, maxWidth);
      const last = pieces.pop();
      lines.push(...pieces);
      current = last ?? '';
    }
    lines.push(current);
  }

  return lines;
}

function splitOversizedWord(
  measurer: TextMeasurer,
  word: string,
  maxWidth: number
): string[] {
  if (measurer.measureText(word).width <= maxWidth) return [word];

  const pieces: string[] = [];
  let chunk = '';
  // Iterating the string yields code points, not UTF-16 units, so surrogate
  // pairs (emoji) are never split down the middle into replacement characters.
  for (const char of word) {
    const candidate = chunk + char;
    if (chunk !== '' && measurer.measureText(candidate).width > maxWidth) {
      pieces.push(chunk);
      chunk = char;
    } else {
      chunk = candidate;
    }
  }
  if (chunk !== '') pieces.push(chunk);
  return pieces;
}

/**
 * Full block layout. Exported so the text tool can size an `autoHeight` element
 * to its content using exactly the metrics the renderer will paint with -
 * measuring twice with two implementations is how a caret ends up half a line
 * off from its glyphs.
 */
export function measureTextBlock(measurer: TextMeasurer, element: TextElement): TextLayout {
  const lines = wrapText(measurer, element.text, element.width);
  // `lineHeight` is a multiplier of font size, not an absolute, so changing the
  // size keeps the same visual leading.
  const lineHeightPx = element.fontSize * element.lineHeight;
  return { lines, lineHeightPx, height: lines.length * lineHeightPx };
}

export const drawText: Drawer<TextElement> = (ctx, element) => {
  if (element.text.length === 0) return;

  ctx.font = fontString(element);
  ctx.fillStyle = element.color;
  ctx.textAlign = element.textAlign;
  // Each line is centred within its own line box. With 'top' or 'alphabetic'
  // the extra leading lands entirely below or above the glyphs, so the block
  // sits visibly off-centre inside its element the moment lineHeight ≠ 1.
  ctx.textBaseline = 'middle';

  const { lines, lineHeightPx } = measureTextBlock(ctx, element);
  const anchorX = alignAnchorX(element.textAlign, element.width);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    ctx.fillText(line, anchorX, (i + 0.5) * lineHeightPx);
  }
};

/** `ctx.textAlign` decides which side of this x the glyphs grow from. */
function alignAnchorX(align: TextAlign, width: number): number {
  switch (align) {
    case 'left':
      return 0;
    case 'center':
      return width / 2;
    case 'right':
      return width;
  }
}
