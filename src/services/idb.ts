/**
 * A hand-written promise wrapper over IndexedDB.
 *
 * No `idb` / `idb-keyval` dependency. The whole surface this app needs is
 * get/put/delete/getAll/getAllKeys over two stores; that is ~150 lines of
 * event-to-promise plumbing, and owning it means the failure modes below are
 * visible in the codebase instead of buried in a transitive package.
 *
 * Three design decisions worth defending:
 *
 * 1. **Out-of-line keys for both stores.** A `keyPath` would work for projects
 *    (they have an `id`) but not for images, which are raw `Blob`s with no
 *    place to hang a key. Explicit keys make one uniform call shape for both.
 *
 * 2. **Writes resolve on `transaction.oncomplete`, not `request.onsuccess`.**
 *    A `put` request "succeeds" as soon as it is queued; quota exhaustion
 *    surfaces later, when the transaction tries to commit. Resolving early
 *    would report a successful save for data that never reached disk - the
 *    exact bug that makes a save indicator lie.
 *
 * 3. **The backend is an interface.** `createMemoryBackend()` is both the
 *    degradation path when IndexedDB is unavailable (Safari private mode,
 *    storage disabled by policy) and the fake the repository tests run
 *    against - one implementation serving both, rather than a test-only mock
 *    that can drift from the real contract.
 */

import { DB_NAME, DB_VERSION, STORE_IMAGES, STORE_PROJECTS } from '@/constants/storage';
import { err, ok, type Result } from './result';

export type StoreName = typeof STORE_PROJECTS | typeof STORE_IMAGES;

export const STORE_NAMES: readonly StoreName[] = [STORE_PROJECTS, STORE_IMAGES];

export type StorageErrorKind =
  /** IndexedDB is missing or refuses to open - private browsing, disabled storage. */
  | 'unavailable'
  /** Out of disk/origin quota. Distinct because the user can actually act on it. */
  | 'quota-exceeded'
  /** Another tab holds an older DB version open and blocks the upgrade. */
  | 'blocked'
  /** Anything else: aborted transaction, corrupt store, unclonable value. */
  | 'io';

export interface StorageError {
  readonly kind: StorageErrorKind;
  readonly message: string;
  readonly cause?: unknown;
}

export function storageError(
  kind: StorageErrorKind,
  message: string,
  cause?: unknown
): StorageError {
  return { kind, message, cause };
}

/**
 * The persistence contract every service above this file depends on.
 *
 * Reads return `unknown` on purpose. Whatever came out of the database was
 * written by an older build, hand-edited, or corrupted; typing it as the shape
 * we *hope* for would be a lie the compiler then propagates. Callers narrow it
 * through the validators in `features/project`.
 */
export interface StorageBackend {
  get(store: StoreName, key: string): Promise<Result<unknown, StorageError>>;
  getAll(store: StoreName): Promise<Result<readonly unknown[], StorageError>>;
  getAllKeys(store: StoreName): Promise<Result<readonly string[], StorageError>>;
  put(store: StoreName, key: string, value: unknown): Promise<Result<void, StorageError>>;
  delete(store: StoreName, key: string): Promise<Result<void, StorageError>>;
}

/* ------------------------------------------------------- error classifying -- */

const QUOTA_ERROR_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

function errorName(cause: unknown): string {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    typeof cause.name === 'string'
  ) {
    return cause.name;
  }
  return '';
}

function classify(cause: unknown, context: string): StorageError {
  const name = errorName(cause);
  if (QUOTA_ERROR_NAMES.has(name)) {
    return storageError(
      'quota-exceeded',
      `Storage is full - ${context} could not be saved.`,
      cause
    );
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return storageError('io', `${context} failed: ${detail}`, cause);
}

/* ---------------------------------------------------------- request/tx glue -- */

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

/* ------------------------------------------------------------------- open -- */

let connection: Promise<Result<IDBDatabase, StorageError>> | null = null;

function openDatabase(): Promise<Result<IDBDatabase, StorageError>> {
  connection ??= openConnection();
  return connection;
}

/** Exposed so a caller that recovered from an error can force a fresh open. */
export function resetConnection(): void {
  connection = null;
}

function openConnection(): Promise<Result<IDBDatabase, StorageError>> {
  // `typeof` rather than a truthiness check: the DOM lib declares `indexedDB`
  // as always present, so `if (!indexedDB)` is dead code to the compiler even
  // though the global is genuinely absent in some environments.
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(
      err(storageError('unavailable', 'IndexedDB is not available in this browser context.'))
    );
  }

  return new Promise<Result<IDBDatabase, StorageError>>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      // Safari in private mode throws synchronously here rather than firing onerror.
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (cause) {
      resolve(
        err(
          storageError(
            'unavailable',
            'Storage is blocked in this browser context - private browsing or a site setting. Changes will be kept in memory only.',
            cause
          )
        )
      );
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };

    request.onblocked = () => {
      resolve(
        err(
          storageError(
            'blocked',
            'Another CanvasForge tab is open with an older version. Close it and reload.'
          )
        )
      );
    };

    request.onerror = () => {
      resolve(err(classify(request.error, 'Opening the database')));
    };

    request.onsuccess = () => {
      const db = request.result;
      // A `versionchange` from another tab, or the browser evicting the origin,
      // leaves this handle dead. Drop the cache so the next call re-opens
      // instead of failing forever against a closed connection.
      db.onversionchange = () => {
        db.close();
        resetConnection();
      };
      db.onclose = () => {
        resetConnection();
      };
      resolve(ok(db));
    };
  });
}

/* -------------------------------------------------------- indexedDB backend -- */

async function withStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  context: string,
  run: (objectStore: IDBObjectStore) => Promise<T>
): Promise<Result<T, StorageError>> {
  const opened = await openDatabase();
  if (!opened.ok) return opened;

  try {
    const tx = opened.value.transaction(store, mode);
    const settled = transactionDone(tx);
    const value = await run(tx.objectStore(store));
    // Reads could resolve here, but awaiting completion for both keeps one code
    // path and guarantees a write is durable before the caller is told it saved.
    await settled;
    return ok(value);
  } catch (cause) {
    return err(classify(cause, context));
  }
}

export function createIndexedDbBackend(): StorageBackend {
  return {
    get: (store, key) =>
      withStore(store, 'readonly', `Reading ${store}/${key}`, (os) =>
        requestToPromise<unknown>(os.get(key))
      ),

    getAll: (store) =>
      withStore(store, 'readonly', `Reading ${store}`, (os) =>
        requestToPromise<unknown[]>(os.getAll())
      ),

    getAllKeys: (store) =>
      withStore(store, 'readonly', `Listing ${store}`, async (os) => {
        const keys = await requestToPromise<IDBValidKey[]>(os.getAllKeys());
        // Both stores are keyed by string (project id / image content hash).
        // A key of any other type was not written by this app, so filtering is
        // more truthful than coercing it into a string that matches nothing.
        return keys.filter((key): key is string => typeof key === 'string');
      }),

    put: (store, key, value) =>
      withStore(store, 'readwrite', `Writing ${store}/${key}`, async (os) => {
        await requestToPromise(os.put(value, key));
      }),

    delete: (store, key) =>
      withStore(store, 'readwrite', `Deleting ${store}/${key}`, async (os) => {
        await requestToPromise(os.delete(key));
      }),
  };
}

/* ------------------------------------------------------------ memory backend -- */

/**
 * In-memory stand-in with the same contract.
 *
 * Production use: when `openDatabase()` reports `unavailable`, the app swaps to
 * this so the editor still works for the session instead of crashing on boot -
 * the user loses persistence, not the app. Test use: the repository suite runs
 * against it, so those tests exercise the real repository logic without needing
 * `fake-indexeddb`.
 *
 * Values are stored by reference. Records in this codebase are treated as
 * immutable, so cloning would cost copies to defend against a mutation that
 * never happens - and `structuredClone` of a `Blob` is not reliable everywhere.
 */
export function createMemoryBackend(): StorageBackend {
  const stores = new Map<StoreName, Map<string, unknown>>(
    STORE_NAMES.map((name) => [name, new Map<string, unknown>()])
  );

  const table = (store: StoreName): Map<string, unknown> => {
    const existing = stores.get(store);
    if (existing) return existing;
    const created = new Map<string, unknown>();
    stores.set(store, created);
    return created;
  };

  return {
    get: (store, key) => Promise.resolve(ok(table(store).get(key))),
    getAll: (store) => Promise.resolve(ok([...table(store).values()])),
    getAllKeys: (store) => Promise.resolve(ok([...table(store).keys()])),
    put: (store, key, value) => {
      table(store).set(key, value);
      return Promise.resolve(ok(undefined));
    },
    delete: (store, key) => {
      table(store).delete(key);
      return Promise.resolve(ok(undefined));
    },
  };
}

/**
 * The backend the app uses by default. Probing availability is async, so this
 * stays IndexedDB-backed and each call reports `unavailable` on its own; the
 * app shell decides whether to swap in a memory backend after the first
 * failure. Doing it that way avoids an await on the boot path.
 */
export const defaultBackend: StorageBackend = createIndexedDbBackend();

/** True when IndexedDB can actually be opened here. For the boot-time probe. */
export async function isStorageAvailable(): Promise<boolean> {
  const opened = await openDatabase();
  return opened.ok;
}
