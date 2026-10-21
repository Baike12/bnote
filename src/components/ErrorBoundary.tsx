import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this clears a previous failure (e.g. opening another PDF). */
  resetKey?: unknown;
  fallback: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a failing subtree from taking the whole window down.
 *
 * React unmounts the entire root when a render/lazy-import error has no
 * boundary. The PDF reader loads a large third-party chunk lazily, so a
 * compatibility error there (a WebKit missing a newer builtin, a corrupt PDF
 * module) used to blank the whole app — no toolbar, no notes, looking frozen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[boundary]", error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (error) return this.props.fallback(error, () => this.setState({ error: null }));
    return this.props.children;
  }
}
