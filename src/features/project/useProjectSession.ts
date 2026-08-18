/**
 * The bridge between the store (which knows nothing about persistence) and the
 * repository (which knows nothing about React).
 *
 * It is written as a **plain service object plus a thin hook**, not as a hook
 * that owns the state. Three reasons:
 *
 *  - The command table needs `newProject` / `save` / `open` and is built outside
 *    React. A hook-owned session would force every command to be threaded
 *    through props or a context.
 *  - The interesting behaviour - restore, debounce, block during a drag, flush
 *    on unload - is imperative and time-dependent, so it is far easier to reason
 *    about (and to test) as a function of events than as a render.
 *  - React 19 StrictMode mounts effects twice. A service with an explicit
 *    `start()`/teardown and a one-shot boot flag survives that; a hook that
 *    kicks off a load in `useEffect` loads the project twice.
 *
 * Autosave discipline (see `services/autosave.ts` for the scheduler itself):
 * `schedule()` on document changes, `setBlocked(true)` while a transaction is
 * open so nothing is written mid-drag, and `flush()` on unload and on every
 * project switch. Load warnings from the validator are surfaced, never
 * swallowed - a project that came back with three elements dropped is something
 * the user must be told about.
 */

import { LS_LAST_PROJECT } from '@/constants';
import { importProjectJson, type ImportError } from '@/features/export/json';
import { elementsToPaint } from '@/features/elements/tree';
import { createDemoProject } from '@/features/project/demoProject';
import { contentBounds } from '@/features/selection/bounds';
import { createAutosaveScheduler, type AutosaveScheduler } from '@/services/autosave';
import { imageStore, type ImageStore } from '@/services/imageStore';
import {
  emptyProject,
  projectRepository,
  type ProjectRepository,
  type RepositoryError,
} from '@/services/projectRepository';
import { err, ok, type Result } from '@/services/result';
import { selectIsTransactionOpen, useCanvasStore, type CanvasStore } from '@/store';
import type { Project, ProjectMetadata } from '@/types';
import { createId } from '@/utils/id';
import { useEffect, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';

export interface ProjectSessionState {
  readonly status: 'loading' | 'ready';
  readonly projectId: string;
  /** Validator notes from the last load - dropped elements, schema upgrades. */
  readonly warnings: readonly string[];
  /** The last storage failure, in words the user can act on. */
  readonly error: string | null;
  /** False once a storage call has reported the backend unusable. */
  readonly persistent: boolean;
}

export interface ProjectSession {
  getState(): ProjectSessionState;
  subscribe(listener: () => void): () => void;
  /** Installs the subscriptions and restores the last document. Returns a teardown. */
  start(): () => void;

  newProject(name?: string): Promise<Result<Project, RepositoryError>>;
  openProject(id: string): Promise<Result<Project, RepositoryError>>;
  openDemo(): Promise<Result<Project, RepositoryError>>;
  /** Copies a project and opens the copy. Defaults to the open one. */
  duplicateProject(id?: string): Promise<Result<Project, RepositoryError>>;
  deleteProject(id: string): Promise<Result<void, RepositoryError>>;
  rename(name: string): void;
  saveNow(): Promise<void>;
  importJson(text: string): Promise<Result<Project, ImportError | RepositoryError>>;
  /** The project as it stands right now - what export and save both serialize. */
  snapshot(): Project;
  isDirty(): boolean;
  dismissWarnings(): void;
}

export interface ProjectSessionOptions {
  readonly store?: StoreApi<CanvasStore>;
  readonly repository?: ProjectRepository;
  readonly images?: ImageStore;
  readonly autosaveDelayMs?: number;
}

function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(LS_LAST_PROJECT);
  } catch {
    return null;
  }
}

function writeLastProjectId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_LAST_PROJECT);
    else localStorage.setItem(LS_LAST_PROJECT, id);
  } catch {
    /* A session that doesn't remember its last project is a far smaller failure than a crash. */
  }
}

export function createProjectSession(options: ProjectSessionOptions = {}): ProjectSession {
  const store = options.store ?? useCanvasStore;
  const repository = options.repository ?? projectRepository;
  const images = options.images ?? imageStore;

  let projectId = '';
  let metadata: ProjectMetadata = { createdAt: '', updatedAt: '' };
  let booted = false;
  let cancelFraming: (() => void) | null = null;
  /** Reference count, so N components calling the hook install one set of listeners. */
  let mounts = 0;
  let teardown: (() => void) | null = null;

  let state: ProjectSessionState = {
    status: 'loading',
    projectId: '',
    warnings: [],
    error: null,
    persistent: true,
  };
  const listeners = new Set<() => void>();

  function setState(patch: Partial<ProjectSessionState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function snapshot(): Project {
    const current = store.getState();
    return {
      id: projectId,
      name: current.projectName,
      viewport: current.viewport,
      elements: current.elements,
      metadata,
    };
  }

  const autosave: AutosaveScheduler = createAutosaveScheduler<RepositoryError>({
    save: async () => {
      const written = await repository.saveProject(snapshot());
      // `updatedAt` is stamped by the repository at write time, so the session's
      // copy is refreshed from what actually reached storage rather than guessed.
      if (written.ok) metadata = { ...metadata, updatedAt: written.value.updatedAt };
      return written;
    },
    onStatusChange: (status) => {
      store.getState().setSaveStatus(status);
    },
    onError: (error) => {
      setState({ error: error.message, persistent: error.kind !== 'unavailable' });
    },
    ...(options.autosaveDelayMs === undefined ? {} : { delayMs: options.autosaveDelayMs }),
  });

  /**
   * Frames a freshly opened document once the canvas has a size.
   *
   * A stored viewport of exactly (0, 0) is the "never framed" marker written by
   * `emptyProject` and by the demo builder - neither knows how big the canvas
   * is. The canvas component publishes its size after mount, which may be after
   * the load resolves, so this waits for the first non-zero size rather than
   * assuming one.
   */
  function frameWhenLaidOut(project: Project): void {
    cancelFraming?.();
    cancelFraming = null;
    if (project.viewport.panX !== 0 || project.viewport.panY !== 0) return;

    const fit = (): boolean => {
      const current = store.getState();
      const { width, height } = current.viewportSize;
      if (width === 0 || height === 0) return false;
      // `elementsToPaint`, not `elementsInOrder`: `order` names root ids only,
      // so a document framed on load has to be measured by what paints.
      const bounds = contentBounds(elementsToPaint(current.elements));
      if (bounds === null) current.resetView(current.viewportSize);
      else current.zoomToFit(bounds, current.viewportSize);
      return true;
    };

    if (fit()) return;

    /*
     * The canvas has not been measured yet, so wait for a store write that
     * brings a size with it.
     *
     * The subtlety - and this crashed the editor before it was handled - is
     * that `fit()` *writes the viewport*, which re-enters this very listener.
     * Unsubscribing after the call is too late: the recursion happens inside
     * it, and `?stress=2000` reproduced a `RangeError: Maximum call stack size
     * exceeded` every time. So the listener tests readiness without writing,
     * detaches itself, and only then fits. The `framed` latch is belt to that
     * brace, since a synchronous re-entry could still arrive between the read
     * and the detach.
     */
    let framed = false;
    const holder: { unsubscribe: (() => void) | null } = { unsubscribe: null };
    holder.unsubscribe = store.subscribe(() => {
      if (framed) return;
      const { width, height } = store.getState().viewportSize;
      if (width === 0 || height === 0) return;

      framed = true;
      holder.unsubscribe?.();
      cancelFraming = null;
      fit();
    });
    cancelFraming = holder.unsubscribe;
  }

  function apply(project: Project, warnings: readonly string[]): void {
    projectId = project.id;
    metadata = project.metadata;

    const current = store.getState();
    // `replaceDocument` also discards both history stacks: the old timeline
    // belongs to a document that is no longer open, and keeping it would let
    // Ctrl+Z paste another project's contents into this one.
    current.replaceDocument(project.elements);
    current.clearSelection();
    // Entering a group is view state about *this* document; carrying it into
    // another project would leave the canvas descended into a group that the
    // new document has never heard of. The layers panel's own view state -
    // which groups it shows folded - is the same kind of fact about the
    // outgoing document, and is dropped for the same reason.
    current.enterGroup(null);
    current.clearCollapsedGroups();
    current.setProjectName(project.name);
    current.setViewport(project.viewport);
    // A document that was just loaded is by definition saved; without this the
    // `replaceDocument` write would immediately mark it dirty.
    autosave.cancel();
    current.setSaveStatus('saved');

    writeLastProjectId(project.id);
    setState({ status: 'ready', projectId: project.id, warnings, error: null });
    frameWhenLaidOut(project);
  }

  /** Falls back to an unpersisted in-memory document so a storage failure is not fatal. */
  function applyUnpersisted(project: Project, message: string): void {
    apply(project, []);
    setState({ error: message, persistent: false });
  }

  async function load(id: string): Promise<Result<Project, RepositoryError>> {
    await autosave.flush();
    const loaded = await repository.loadProject(id);
    if (!loaded.ok) return err(loaded.error);
    apply(loaded.value.project, loaded.value.warnings);
    return ok(loaded.value.project);
  }

  async function create(project: Project): Promise<Result<Project, RepositoryError>> {
    await autosave.flush();
    const written = await repository.saveProject(project);
    if (!written.ok) {
      applyUnpersisted(project, written.error.message);
      return err(written.error);
    }
    apply(project, []);
    return ok(project);
  }

  /**
   * Boot order: the last project, then the most recent project, then - on a
   * genuinely empty install - the demo. The demo is the default rather than an
   * empty canvas because the first screen of the product should show what the
   * product does.
   */
  async function restore(): Promise<void> {
    const lastId = readLastProjectId();
    if (lastId !== null && (await load(lastId)).ok) return;

    const listed = await repository.listProjects();
    if (!listed.ok) {
      applyUnpersisted(createDemoProject(), listed.error.message);
      return;
    }
    const mostRecent = listed.value[0];
    if (mostRecent !== undefined && (await load(mostRecent.id)).ok) return;

    await create(createDemoProject());
  }

  return {
    getState: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start: () => {
      mounts += 1;
      if (mounts > 1) {
        return () => {
          mounts -= 1;
        };
      }

      const unsubscribeStore = store.subscribe((next, previous) => {
        // The viewport is deliberately not a trigger. It is saved with the next
        // document write, but panning is not an edit and treating it as one
        // would re-arm the debounce on every wheel event.
        if (next.elements !== previous.elements || next.projectName !== previous.projectName) {
          autosave.schedule();
        }
        const open = selectIsTransactionOpen(next);
        if (open !== selectIsTransactionOpen(previous)) autosave.setBlocked(open);
      });

      const flush = (): void => {
        void autosave.flush();
      };
      const onVisibility = (): void => {
        // The reliable one. `beforeunload` is skipped entirely on mobile Safari
        // and when a tab is discarded, whereas `hidden` always fires first.
        if (document.visibilityState === 'hidden') flush();
      };
      window.addEventListener('beforeunload', flush);
      document.addEventListener('visibilitychange', onVisibility);

      if (!booted) {
        booted = true;
        void restore();
      }

      teardown = () => {
        unsubscribeStore();
        window.removeEventListener('beforeunload', flush);
        document.removeEventListener('visibilitychange', onVisibility);
        cancelFraming?.();
        cancelFraming = null;
        flush();
      };

      return () => {
        mounts -= 1;
        if (mounts > 0) return;
        teardown?.();
        teardown = null;
      };
    },

    newProject: (name) => create(emptyProject(name ?? 'Untitled')),
    openProject: (id) => load(id),
    openDemo: () => create(createDemoProject()),

    duplicateProject: async (id) => {
      // Flushed first so a duplicate of the open document copies what is on
      // screen, not whatever the last debounced write happened to catch.
      await autosave.flush();
      const copy = await repository.duplicateProject(id ?? projectId);
      if (!copy.ok) {
        setState({ error: copy.error.message });
        return copy;
      }
      // The copy is opened rather than left in the list: "duplicate" with no
      // visible outcome is indistinguishable from a command that did nothing.
      apply(copy.value, []);
      return copy;
    },

    deleteProject: async (id) => {
      const removed = await repository.deleteProject(id);
      if (!removed.ok) {
        setState({ error: removed.error.message });
        return removed;
      }
      // Deleting the open document leaves the editor pointing at nothing, so it
      // is immediately replaced rather than left in an undefined state.
      if (id === projectId) await restore();
      return removed;
    },

    rename: (name) => {
      store.getState().setProjectName(name);
    },

    saveNow: () => autosave.flush(),

    importJson: async (text) => {
      const parsed = importProjectJson(text);
      if (!parsed.ok) return err(parsed.error);

      // Inlined images become blobs before the document lands, so the renderer
      // resolves them on the very first frame instead of drawing placeholders.
      for (const [key, dataUri] of Object.entries(parsed.value.images)) {
        await images.putImageDataUri(key, dataUri);
      }

      // A fresh id: an imported file may carry the id of a project that already
      // exists here, and reusing it would silently overwrite that project.
      const imported: Project = { ...parsed.value.project, id: createId() };
      const written = await create(imported);
      if (written.ok && parsed.value.warnings.length > 0) {
        setState({ warnings: parsed.value.warnings });
      }
      return written;
    },

    snapshot,
    isDirty: () => autosave.isDirty(),
    dismissWarnings: () => {
      setState({ warnings: [] });
    },
  };
}

/** The editor's session. One document is open at a time, so one instance. */
export const projectSession: ProjectSession = createProjectSession();

function subscribeSession(listener: () => void): () => void {
  return projectSession.subscribe(listener);
}

function getSessionState(): ProjectSessionState {
  return projectSession.getState();
}

/**
 * Mounts the session and re-renders on its state.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the session is an
 * external mutable source, and this is the API that exists precisely so React
 * cannot tear between a read and a subsequent render. `start()` is reference
 * counted, so more than one caller - or StrictMode's double mount - installs
 * one set of listeners and restores one document.
 */
export function useProjectSession(): ProjectSessionState {
  useEffect(() => projectSession.start(), []);
  return useSyncExternalStore(subscribeSession, getSessionState, getSessionState);
}
