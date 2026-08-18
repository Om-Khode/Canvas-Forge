/**
 * Debounced autosave scheduler.
 *
 * Framework-free by design: it holds no React state and imports no store, so it
 * is a plain object with four methods that can be driven entirely by fake
 * timers in a unit test. The editor wires it up by calling `schedule()` from a
 * store subscription and rendering `SaveStatus` in the toolbar.
 *
 * Two behaviours are worth spelling out.
 *
 * **Blocking.** A drag produces a store write per pointermove. Saving in the
 * middle of one would serialize a half-finished transform and - worse - do it
 * sixty times a second. `setBlocked(true)` at `beginTransaction` and
 * `setBlocked(false)` at commit means writes only ever see committed states.
 * Unblocking restarts the debounce rather than firing immediately, because the
 * end of a drag is very often followed by another edit.
 *
 * **Coalescing in-flight saves.** If an edit lands while a write is running,
 * the scheduler does not start a second write. It marks the document dirty
 * again and re-arms after the current one settles, so concurrent writes to the
 * same key cannot interleave and the last write always reflects the last edit.
 */

import { AUTOSAVE_DEBOUNCE_MS } from '@/constants/storage';
import type { SaveStatus } from '@/types';
import { type Result } from './result';

export interface AutosaveScheduler {
  /** Mark the document dirty and (re)start the debounce. */
  schedule(): void;
  /** Save now, bypassing both the debounce and the block. Resolves when settled. */
  flush(): Promise<void>;
  /** Drop the pending save. Does not change a status of `saved`. */
  cancel(): void;
  /** True while a transaction is open. Blocks the timer, not `flush`. */
  setBlocked(blocked: boolean): void;
  getStatus(): SaveStatus;
  isDirty(): boolean;
  /** Cancels and detaches. Call on editor unmount. */
  dispose(): void;
}

export interface AutosaveOptions<E> {
  /** The write. Returning a `Result` keeps failure on the happy path's type. */
  readonly save: () => Promise<Result<unknown, E>>;
  readonly onStatusChange?: (status: SaveStatus) => void;
  /** Called with the error when a save fails, so the UI can show the reason. */
  readonly onError?: (error: E) => void;
  readonly delayMs?: number;
}

export function createAutosaveScheduler<E>(options: AutosaveOptions<E>): AutosaveScheduler {
  const delayMs = options.delayMs ?? AUTOSAVE_DEBOUNCE_MS;

  let status: SaveStatus = 'saved';
  let dirtyFlag = false;
  let blocked = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  /**
   * `dirty` is read and written from inside async closures, so it is reached
   * through accessors rather than directly. Reading the variable would let the
   * compiler's control-flow analysis narrow it to the last literal assigned on
   * this path - the closure's later `setDirty(true)` is invisible to that
   * analysis, and the check would be silently constant-folded.
   */
  function isDirty(): boolean {
    return dirtyFlag;
  }

  function setDirty(next: boolean): void {
    dirtyFlag = next;
  }

  function setStatus(next: SaveStatus): void {
    if (status === next) return;
    status = next;
    options.onStatusChange?.(next);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(): void {
    if (disposed) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (blocked) {
        // Re-arm instead of dropping: the edit is still unsaved, and the
        // transaction will end eventually. Dropping here would mean a drag that
        // outlives the debounce never triggers a save at all.
        arm();
        return;
      }
      void run();
    }, delayMs);
  }

  async function run(): Promise<void> {
    if (running) {
      // A save is already in flight. `dirty` is still set, so the tail of the
      // running save will re-arm for us.
      await running;
      return;
    }
    if (!isDirty()) return;

    setDirty(false);
    setStatus('saving');

    const settle = (async () => {
      const result = await options.save();
      if (result.ok) {
        // Only claim "saved" if nothing changed while the write was in flight.
        setStatus(isDirty() ? 'unsaved' : 'saved');
      } else {
        // The edit was never persisted, so it is still pending: mark dirty
        // again so a later flush or schedule retries it rather than losing it.
        setDirty(true);
        setStatus('error');
        options.onError?.(result.error);
      }
    })();

    running = settle.finally(() => {
      running = null;
    });

    await running;
    // Not re-armed after an error: a failing write (a full disk, a blocked
    // origin) would fail again immediately, and a retry loop would turn one
    // problem into a spin. The next `schedule()` or `flush()` retries.
    if (isDirty() && !disposed && status !== 'error') arm();
  }

  return {
    schedule: () => {
      if (disposed) return;
      setDirty(true);
      if (status !== 'saving') setStatus('unsaved');
      arm();
    },

    flush: async () => {
      clearTimer();
      // Deliberately ignores `blocked`. `flush` is an explicit "save now" -
      // closing the project, switching documents, `visibilitychange` - where
      // losing the edit is worse than saving a mid-transaction state.
      if (running) await running;
      await run();
    },

    cancel: () => {
      clearTimer();
      setDirty(false);
      if (status === 'unsaved') setStatus('saved');
    },

    setBlocked: (next) => {
      const wasBlocked = blocked;
      blocked = next;
      if (wasBlocked && !next && isDirty()) arm();
    },

    getStatus: () => status,
    isDirty,

    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
