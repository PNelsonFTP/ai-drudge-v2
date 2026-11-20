// Error boundary: a render error must never leave a blank tab (V1 had no boundary - one
// wrong-shaped payload blanked the page until the tab was closed).
//
// Two are mounted: one around the whole shell (scope "app") and one around the route outlet
// (scope "page", reset when the route changes) so the chrome survives a broken page.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { CACHE_KEYS } from "./services";

/**
 * Drop the sessionStorage payload cache so a plain reload starts from the network: a cached payload
 * of the wrong shape is the likeliest reason a render threw. Reader state (localStorage) is never
 * touched.
 */
export function clearPayloadCache(storage?: Pick<Storage, "removeItem"> | null): void {
  try {
    const target = storage ?? (typeof sessionStorage === "undefined" ? null : sessionStorage);
    if (!target) return;
    for (const key of Object.values(CACHE_KEYS)) target.removeItem(key);
  } catch {
    // Storage can be blocked (private mode, sandboxed frame); recovery by reload still works.
  }
}

export interface ErrorPanelProps {
  error: Error;
  scope: "app" | "page";
  onRetry?: () => void;
}

/** The friendly fallback. Plain markup + tokens only: it must render even when the rest cannot. */
export function ErrorPanel({ error, scope, onRetry }: ErrorPanelProps) {
  // The app-level panel replaces the whole page, so it carries the page's only <h1>.
  const Heading = scope === "app" ? "h1" : "h2";
  return (
    <div className="error-panel" role="alert">
      <Heading className="section-heading">{scope === "app" ? "AI DRUDGE could not start" : "This page could not be shown"}</Heading>
      <p>
        Something went wrong while drawing {scope === "app" ? "the site" : "this page"}. Your bookmarks, read-later list and settings are
        untouched. Reloading usually fixes it.
      </p>
      <div className="error-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        {onRetry && (
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        )}
        {scope === "page" && (
          <a className="btn" href="#/">
            Front page
          </a>
        )}
      </div>
      <details>
        <summary>Technical detail</summary>
        <pre>{error.message || String(error)}</pre>
      </details>
    </div>
  );
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** "app": the whole shell failed. "page": only the route outlet failed. */
  scope?: "app" | "page";
  /** The error is cleared when this value changes (pass the route key). */
  resetKey?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * Called when the reader presses "Try again", before the error is cleared. Clearing alone
   * re-renders the SAME children: a page whose chunk failed is a React.lazy component that keeps
   * its rejection for good, so the owner of the children must hand over new ones (RouteOutlet asks
   * the route registry again).
   */
  onRetry?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: string | undefined;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    clearPayloadCache();
    this.props.onError?.(error, info);
    console.error("[ai-drudge] render error", error, info.componentStack);
  }

  private retry = (): void => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorPanel error={error} scope={this.props.scope ?? "page"} onRetry={this.retry} />;
  }
}
