import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, EmptyState, IconButton, TextField } from '@/components/common';
import { projectSession, useProjectSession } from '@/features/project/useProjectSession';
import { projectRepository, type RepositoryError } from '@/services/projectRepository';
import type { Result } from '@/services/result';
import { useCanvasStore } from '@/store';
import type { ProjectSummary } from '@/types';
import { cn } from '@/utils/cn';
import { Copy, FolderOpen, Pencil, Trash2 } from 'lucide-react';

/**
 * The project manager.
 *
 * Every storage call in here returns a `Result`, and none of them is collapsed
 * with `unwrapOr`. That is the whole reason the repository is typed that way:
 * "IndexedDB is blocked in this browser context" and "you have no projects yet"
 * are completely different states, and a fallback to `[]` renders them
 * identically - an empty list that quietly implies the user's work is gone.
 * So the error is kept and rendered as itself.
 *
 * Delete confirmation is inline in the row rather than a second modal. Stacking
 * dialogs means two focus traps and two Escape handlers competing, and the row
 * already provides all the context ("delete *this* one") that a confirmation
 * dialog would have to restate.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

function relativeTime(iso: string): string {
  const when = Date.parse(iso);
  if (Number.isNaN(when)) return 'never saved';
  const seconds = (when - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function ProjectDialog() {
  const open = useCanvasStore((state) => state.activeDialog === 'projects');
  const closeDialog = useCanvasStore((state) => state.closeDialog);
  const session = useProjectSession();

  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const applyListing = useCallback(
    (listed: Result<readonly ProjectSummary[], RepositoryError>): void => {
      setLoaded(true);
      if (!listed.ok) {
        // Kept, not swallowed: this is the difference between "storage is
        // blocked" and "you have no projects".
        setError(listed.error.message);
        return;
      }
      setError(null);
      setProjects(listed.value);
    },
    []
  );

  const refresh = useCallback(async (): Promise<void> => {
    applyListing(await projectRepository.listProjects());
  }, [applyListing]);

  // Row-level state is reset by adjusting state during render; the listing is
  // fetched in an effect because it is genuinely an external read.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setRenamingId(null);
    setConfirmingId(null);
  }

  useEffect(() => {
    if (!open) return;
    // Guarded against a listing that resolves after the dialog closed or after
    // the project switched - the later render would otherwise show stale rows.
    let cancelled = false;
    void projectRepository.listProjects().then((listed) => {
      if (!cancelled) applyListing(listed);
    });
    return () => {
      cancelled = true;
    };
  }, [open, applyListing, session.projectId]);

  const commitRename = async (id: string): Promise<void> => {
    const name = draftName.trim();
    setRenamingId(null);
    if (name.length === 0) return;

    if (id === session.projectId) {
      // The open document renames through the session so the store, the title
      // bar, and autosave all see it; writing straight to storage would leave
      // the in-memory document holding the old name until the next reload.
      projectSession.rename(name);
      await projectSession.saveNow();
    } else {
      const loadedProject = await projectRepository.loadProject(id);
      if (!loadedProject.ok) {
        setError(loadedProject.error.message);
        return;
      }
      const written = await projectRepository.saveProject({ ...loadedProject.value.project, name });
      if (!written.ok) {
        setError(written.error.message);
        return;
      }
    }
    await refresh();
  };

  /** Runs a repository action, keeps its error instead of discarding it, re-lists. */
  const act = async (
    run: () => Promise<Result<unknown, { readonly message: string }>>
  ): Promise<void> => {
    const result = await run();
    if (!result.ok) setError(result.error.message);
    await refresh();
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      title="Projects"
      description="Everything is stored in this browser. Nothing is uploaded."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void act(() => projectSession.newProject());
            }}
          >
            New project
          </Button>
        </>
      }
    >
      {!session.persistent && (
        <p role="status" className="text-danger mb-3 text-[0.8125rem] leading-snug">
          Storage is unavailable in this browser context, so changes are kept in memory only and
          will be lost when the tab closes.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-danger mb-3 text-[0.8125rem] leading-snug">
          {error}
        </p>
      )}

      {loaded && projects.length === 0 && error === null ? (
        <EmptyState
          icon={FolderOpen}
          size="md"
          title="No saved projects"
          description="Create one to start drawing - it is saved as you go."
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {projects.map((project) => {
            const current = project.id === session.projectId;
            return (
              <li
                key={project.id}
                className={cn(
                  'border-edge rounded-control flex items-center gap-2 border px-3 py-2',
                  current ? 'bg-surface-2' : 'bg-surface-1'
                )}
              >
                {renamingId === project.id ? (
                  <TextField
                    label="Project name"
                    hideLabel
                    fieldSize="sm"
                    autoFocus
                    className="min-w-0 flex-1"
                    value={draftName}
                    onChange={setDraftName}
                    onCommit={() => {
                      void commitRename(project.id);
                    }}
                    onCancel={() => {
                      setRenamingId(null);
                    }}
                  />
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="text-ink truncate text-[0.8125rem] font-medium">
                      {project.name}
                      {current && <span className="text-ink-muted font-normal"> · open</span>}
                    </p>
                    <p className="text-ink-muted text-[0.75rem]">
                      {project.elementCount} element{project.elementCount === 1 ? '' : 's'} · edited{' '}
                      {relativeTime(project.updatedAt)}
                    </p>
                  </div>
                )}

                {confirmingId === project.id ? (
                  <>
                    <span className="text-ink-soft text-[0.75rem]">Delete permanently?</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirmingId(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setConfirmingId(null);
                        void act(() => projectSession.deleteProject(project.id));
                      }}
                    >
                      Delete
                    </Button>
                  </>
                ) : (
                  <>
                    {!current && (
                      <Button
                        size="sm"
                        onClick={() => {
                          void act(() => projectSession.openProject(project.id));
                        }}
                      >
                        Open
                      </Button>
                    )}
                    <IconButton
                      icon={Pencil}
                      label={`Rename ${project.name}`}
                      size="sm"
                      onClick={() => {
                        setDraftName(project.name);
                        setRenamingId(project.id);
                      }}
                    />
                    <IconButton
                      icon={Copy}
                      label={`Duplicate ${project.name}`}
                      size="sm"
                      onClick={() => {
                        void act(() => projectSession.duplicateProject(project.id));
                      }}
                    />
                    <IconButton
                      icon={Trash2}
                      label={`Delete ${project.name}`}
                      size="sm"
                      onClick={() => {
                        setConfirmingId(project.id);
                      }}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
