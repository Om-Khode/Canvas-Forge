/**
 * `Result<T, E>` - failures as values, not exceptions.
 *
 * Why this exists in a front-end app, where `try/catch` is the norm:
 *
 * In a local-first editor the things that go wrong are *expected conditions*,
 * not exceptional ones. Storage quota is finite and users fill it. Safari
 * private mode refuses `indexedDB.open` outright. An imported project file is
 * untrusted input and is routinely corrupt or from a future version. Every one
 * of those is a state the UI has to render - a toast, a save-status pill, a
 * "this file came from a newer version" dialog.
 *
 * A thrown exception is invisible to the type system: nothing tells the caller
 * it exists and nothing complains when it isn't handled, so the failure path is
 * discovered in production. Putting the failure in the return type means the
 * compiler forces the caller to narrow `ok` before reading `value`, and the UI
 * cannot forget the branch. Exceptions stay reserved for genuine programmer
 * error (`assertNever`), where crashing loudly is the correct behaviour.
 */

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** `never` as the error type so an `ok` is assignable to any `Result<T, E>`. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(
  result: Result<T, E>
): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapError<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Boundary adapter: wraps a throwing async API (IndexedDB, `Blob.arrayBuffer`,
 * `crypto.subtle`) so everything above the boundary speaks `Result`. The
 * `toError` mapper is required rather than optional because a bare `unknown`
 * error propagated upward defeats the point of typing the failure.
 */
export async function tryCatchAsync<T, E>(
  fn: () => Promise<T>,
  toError: (cause: unknown) => E
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(toError(cause));
  }
}

export function tryCatchSync<T, E>(fn: () => T, toError: (cause: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(toError(cause));
  }
}

/** Best-effort human-readable text from an unknown thrown value. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}
