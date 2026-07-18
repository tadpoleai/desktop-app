import React from "react";
import { ErrorState } from "./ErrorState";

interface Props {
  children: React.ReactNode;
  /** Remount children (clears the error) whenever this key changes — e.g. pass the active view id. */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Catches uncaught render errors in the wrapped subtree so one broken view
 * (e.g. a workflow whose operator manifest failed to resolve) shows a
 * retry-able error message instead of blanking the entire app window —
 * React unmounts the whole tree on an uncaught render exception by default.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Render error caught by ErrorBoundary:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          message={`页面渲染出错：${this.state.error.message}`}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}
