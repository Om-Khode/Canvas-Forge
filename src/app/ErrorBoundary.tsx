import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  /** Shown instead of the default panel. Receives the error and a reset callback. */
  readonly fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Label used in the default message, e.g. "the layers panel". */
  readonly label?: string;
}

interface State {
  readonly error: Error | null;
}

/**
 * A render-time crash in one panel should not take down the editor and lose
 * unsaved work. Boundaries are placed around each independently-recoverable
 * region (canvas, panels, dialogs) rather than only at the root.
 *
 * Note this catches render/lifecycle errors only - event-handler and async
 * failures are handled at their call sites, which is why services return
 * results rather than throwing into the void.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[CanvasForge] ${this.props.label ?? 'component'} crashed`, error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p className="text-ink text-sm font-medium">
          Something went wrong in {this.props.label ?? 'this area'}.
        </p>
        <p className="text-ink-muted max-w-sm text-xs">{error.message}</p>
        <button
          type="button"
          onClick={this.reset}
          className="border-edge-strong text-ink hover:bg-surface-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }
}
