import { AlertTriangle, Check, CloudOff, RefreshCw } from 'lucide-react';
import { useCanvasStore } from '@/store';
import { projectSession, useProjectSession } from '@/features/project/useProjectSession';
import { cn } from '@/utils/cn';

/**
 * The save indicator.
 *
 * A local-first editor makes a promise - your work is safe without an account -
 * and that promise is invisible unless something says so. This is the only
 * surface that tells the user their work reached IndexedDB, and the only place
 * a storage failure becomes visible rather than silent.
 *
 * Three deliberate choices:
 *
 *  - **The error state is the loud one.** `saved` is a quiet grey tick; a failed
 *    write is coloured and keeps its label at every width. A user who cannot be
 *    told "this did not save" will discover it by losing work.
 *  - **`saving` is not animated into prominence.** Autosave fires ~800ms after
 *    every edit, so a spinner that draws the eye would flicker constantly during
 *    normal work. It is a low-contrast label that changes text, nothing more.
 *  - **Load warnings live here too.** The validator drops malformed elements and
 *    reports them rather than failing the whole file (docs/decisions/004), and
 *    that report has to reach the user or the leniency is indistinguishable from
 *    data loss. Anything else in the toolbar would be the wrong neighbourhood:
 *    this is the "state of your document on disk" corner.
 */

const STATUS_TEXT = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  error: "Couldn't save",
} as const;

export function SaveStatus() {
  const status = useCanvasStore((state) => state.saveStatus);
  const session = useProjectSession();
  const warnings = session.warnings;

  const failed = status === 'error' || !session.persistent;
  const Icon = failed ? CloudOff : status === 'saving' ? RefreshCw : Check;

  // Storage being unavailable outranks the write status: "Saved" would be a lie
  // in a private window where nothing can be written at all.
  const label = session.persistent ? STATUS_TEXT[status] : 'Not saved - storage unavailable';

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        // polite, not assertive: this updates on a timer during ordinary
        // editing, and an assertive region would interrupt a screen reader
        // mid-sentence every time autosave ran.
        role="status"
        aria-live="polite"
        className={cn(
          'flex min-w-0 items-center gap-1.5 px-1.5 text-[0.6875rem] font-medium',
          failed ? 'text-danger' : 'text-ink-muted'
        )}
      >
        <Icon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        {/* Hidden below `sm` for space, but never when it is bad news, and the
            accessible name is unaffected either way. */}
        <span className={cn('truncate', !failed && 'hidden md:inline')}>{label}</span>
      </span>

      {warnings.length > 0 && (
        <button
          type="button"
          onClick={() => {
            // Wrapped rather than passed as a bare method reference: detaching
            // it from the session object loses its `this` binding.
            projectSession.dismissWarnings();
          }}
          title={warnings.join('\n')}
          className={cn(
            'text-warning hover:bg-surface-2 rounded-field flex items-center gap-1 px-1.5 py-1',
            'text-[0.6875rem] font-medium transition-colors duration-120 ease-out'
          )}
        >
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span>
            {warnings.length} {warnings.length === 1 ? 'issue' : 'issues'} on load
          </span>
        </button>
      )}
    </div>
  );
}
