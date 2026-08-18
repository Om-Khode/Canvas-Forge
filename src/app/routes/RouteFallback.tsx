/**
 * Shown while the code-split editor bundle downloads. Deliberately quiet - a
 * spinner that appears for 80ms on a fast connection is worse than nothing, so
 * this fades in with a delay via CSS rather than appearing instantly.
 */
export function RouteFallback() {
  return (
    <div
      className="bg-surface-0 flex h-dvh w-full items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <span className="text-ink-muted animate-pulse text-sm">Loading editor…</span>
    </div>
  );
}
