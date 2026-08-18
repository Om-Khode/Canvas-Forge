/**
 * Copy / cut / paste / duplicate.
 *
 * ## Why there are two clipboards
 *
 * The **internal buffer** is the authority. It is synchronous, it needs no
 * permission, it holds real `CanvasElement` objects rather than a re-parsed
 * approximation of them, and it is what makes Ctrl+V instant. Reading the
 * system clipboard, by contrast, is `async` and prompts the user in Safari and
 * Firefox - a permission dialog in the middle of a paste is a worse experience
 * than any feature it could buy.
 *
 * The **system clipboard** is still written on every copy, as a serialized
 * payload, because that is the only thing that crosses a tab boundary: two
 * CanvasForge tabs share nothing else. It is a best-effort enhancement - if the
 * write is refused (no `navigator.clipboard`, an insecure origin, a denied
 * permission) the copy still succeeded and nothing is reported.
 *
 * Reading it back happens on two paths, in this order of preference:
 *
 *  - `pasteFromEvent` - the DOM `paste` event carries the data with it, so
 *    there is no permission prompt at all. This is the good path, and it fires
 *    for the Edit menu and the context menu.
 *  - `pasteAsync` - an explicit `readText()`, tried **only** when the internal
 *    buffer is empty (a tab that has never copied anything). This is where a
 *    prompt may appear, which is exactly the situation where the user has asked
 *    for a paste and has nothing local to serve it from.
 *
 * ## Why the payload is validated
 *
 * Anything read back from the system clipboard is untrusted text - the user
 * may have copied it from anywhere, and a project file's colour and image
 * fields feed straight into `fillStyle` and `Image.src`. It goes through the
 * same `validateElement` the project loader uses, with the same drop-and-warn
 * policy, rather than being cast into shape.
 */

import { cloneElements, type CloneResult } from '@/features/elements/clone';
import { unionBounds } from '@/features/elements/operations';
import { validateElement } from '@/features/project/validate';
import type { CanvasElement, Vec2 } from '@/types';

export const CLIPBOARD_KIND = 'canvasforge/clipboard';
export const CLIPBOARD_VERSION = 1;
/** The MIME the payload is written under. `text/plain` is the only type every browser lets us write. */
export const CLIPBOARD_MIME = 'text/plain';

export interface ClipboardPayload {
  readonly kind: typeof CLIPBOARD_KIND;
  readonly version: number;
  /**
   * Which document the copy came from. A paste back into the same document
   * cascades from the original; a paste into a *different* one has no original
   * to sit beside, so it is re-anchored instead.
   */
  readonly documentId: string;
  readonly elements: readonly CanvasElement[];
}

export interface CopyContext {
  /**
   * The selected elements plus their descendants - selection order, each one
   * followed immediately by its own subtree in DFS order (`withDescendants` in
   * `createCommands.ts`). Not paint order: a multi-select copy keeps whatever
   * order the user built the selection in, group-before-members, which is what
   * `addElements` needs the group to precede its members on the way back in.
   */
  readonly elements: readonly CanvasElement[];
  readonly documentId: string;
}

export interface PasteContext {
  readonly documentId: string;
  /** Where a cross-document paste is centred - the pointer, or the viewport centre. */
  readonly anchorWorld: Vec2;
}

export interface PasteResult extends CloneResult {
  readonly source: 'internal' | 'system';
}

/** The two calls this module makes against `navigator.clipboard`, injected for tests. */
export interface SystemClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

export interface Clipboard {
  /** Returns false when there was nothing to copy. */
  copy(context: CopyContext): boolean;
  /** True when a paste would definitely produce something. */
  isEmpty(): boolean;
  /**
   * Whether "Paste" should be offered. Honest rather than optimistic: it is
   * true when the internal buffer has content, or when a system read is at
   * least possible. It cannot be exact without an async read, and blocking the
   * palette on one would make opening it feel slow.
   */
  canPaste(): boolean;
  /** Synchronous paste from the internal buffer. `null` when it is empty. */
  paste(context: PasteContext): PasteResult | null;
  /** Internal buffer first, then a best-effort system-clipboard read. */
  pasteAsync(context: PasteContext): Promise<PasteResult | null>;
  /** The promptless cross-tab path - the browser hands us the data with the event. */
  pasteFromEvent(event: ClipboardEvent, context: PasteContext): PasteResult | null;
  clear(): void;
}

/* --------------------------------------------------------------- payload -- */

export function buildPayload(context: CopyContext): ClipboardPayload | null {
  if (context.elements.length === 0) return null;
  return {
    kind: CLIPBOARD_KIND,
    version: CLIPBOARD_VERSION,
    documentId: context.documentId,
    elements: context.elements,
  };
}

export function serializePayload(payload: ClipboardPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parses text that may or may not be one of our payloads.
 *
 * Never throws and never reports: the overwhelmingly common case is that the
 * user copied a URL and the answer is simply "not ours".
 */
export function parsePayload(text: string): ClipboardPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== CLIPBOARD_KIND) return null;
  if (typeof record.version !== 'number' || record.version > CLIPBOARD_VERSION) return null;
  if (!Array.isArray(record.elements)) return null;

  const elements: CanvasElement[] = [];
  for (const raw of record.elements as readonly unknown[]) {
    const validated = validateElement(raw);
    // Drop-and-continue, matching the project loader: one malformed element in
    // a pasted payload costs that element, not the whole paste.
    if (validated.ok) elements.push(validated.value);
  }
  if (elements.length === 0) return null;

  return {
    kind: CLIPBOARD_KIND,
    version: record.version,
    documentId: typeof record.documentId === 'string' ? record.documentId : '',
    elements,
  };
}

/**
 * Fresh ids plus the offset the paste should land at.
 *
 * Same document: the classic diagonal nudge, so the copy is visibly on top of
 * its original. Different document (or a payload from another tab): there is no
 * original here, and the source document's coordinates are meaningless in this
 * one - pasting at them can drop the elements somewhere off screen entirely. So
 * the set is centred on the anchor the caller supplies.
 */
export function placeForPaste(payload: ClipboardPayload, context: PasteContext): CloneResult {
  if (payload.documentId === context.documentId) return cloneElements(payload.elements);

  const bounds = unionBounds(payload.elements);
  return cloneElements(payload.elements, {
    x: context.anchorWorld.x - (bounds.x + bounds.width / 2),
    y: context.anchorWorld.y - (bounds.y + bounds.height / 2),
  });
}

/**
 * Duplicate. Deliberately *not* a copy followed by a paste: duplicating must
 * not overwrite whatever the user has on the clipboard, which is a surprise
 * every editor that implements it that way inflicts on its users.
 */
export function duplicateElements(elements: readonly CanvasElement[]): CloneResult | null {
  if (elements.length === 0) return null;
  return cloneElements(elements);
}

/* ------------------------------------------------------------- clipboard -- */

function defaultSystemClipboard(): SystemClipboard | null {
  // Optional-chained through `navigator` itself: this module is imported in
  // environments (tests, SSR) where the global exists but the API does not.
  const api: unknown = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (typeof api !== 'object' || api === null) return null;
  const candidate = api as Partial<SystemClipboard>;
  if (typeof candidate.writeText !== 'function') return null;
  return {
    writeText: (text) => candidate.writeText?.(text) ?? Promise.reject(new Error('unavailable')),
    readText: () => candidate.readText?.() ?? Promise.reject(new Error('unavailable')),
  };
}

export interface ClipboardOptions {
  /** `null` disables the system-clipboard bridge entirely. */
  readonly system?: SystemClipboard | null;
}

export function createClipboard(options: ClipboardOptions = {}): Clipboard {
  const system = options.system === undefined ? defaultSystemClipboard() : options.system;
  let buffer: ClipboardPayload | null = null;

  const place = (
    payload: ClipboardPayload,
    context: PasteContext,
    source: 'internal' | 'system'
  ) => ({
    ...placeForPaste(payload, context),
    source,
  });

  return {
    copy: (context) => {
      const payload = buildPayload(context);
      if (payload === null) return false;
      buffer = payload;

      // Fire-and-forget. A rejected write means cross-tab paste won't work for
      // this copy; it does not mean the copy failed, so nothing is surfaced.
      if (system !== null) {
        void system.writeText(serializePayload(payload)).catch(() => undefined);
      }
      return true;
    },

    isEmpty: () => buffer === null,

    canPaste: () => buffer !== null || system !== null,

    paste: (context) => (buffer === null ? null : place(buffer, context, 'internal')),

    pasteAsync: async (context) => {
      if (buffer !== null) return place(buffer, context, 'internal');
      if (system === null) return null;

      const text = await system.readText().catch(() => null);
      if (text === null) return null;
      const payload = parsePayload(text);
      return payload === null ? null : place(payload, context, 'system');
    },

    pasteFromEvent: (event, context) => {
      const text = event.clipboardData?.getData(CLIPBOARD_MIME) ?? '';
      const payload = text.length === 0 ? null : parsePayload(text);
      // The event's payload wins over the internal buffer only when it *is* one
      // of ours; otherwise (a URL, some prose) fall back to what we hold.
      if (payload !== null) return place(payload, context, 'system');
      return buffer === null ? null : place(buffer, context, 'internal');
    },

    clear: () => {
      buffer = null;
    },
  };
}

/** The instance the editor uses. Tests construct their own. */
export const clipboard: Clipboard = createClipboard();
