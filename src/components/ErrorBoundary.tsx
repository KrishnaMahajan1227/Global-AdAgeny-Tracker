import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** A short label for which part of the app this boundary is guarding —
   *  shown in the fallback and in the console log, so if this ever fires
   *  in production, the report says exactly where. */
  boundaryName?: string;
}

interface State {
  error: Error | null;
}

/**
 * Without this, this app had ZERO error boundaries anywhere — a single
 * unhandled error thrown during render, on any page, unmounted the
 * entire React tree and left the browser showing a blank white screen
 * with no way back except a manual hard refresh. That is almost
 * certainly what "click another nav item, it works, then Campaigns goes
 * blank, have to refresh" actually was: some render-time error on that
 * page (or one it navigated from) with nothing anywhere to catch it.
 *
 * This does not replace finding and fixing that underlying bug — it's a
 * safety net so the SAME class of bug, wherever it next occurs, shows a
 * recoverable "something went wrong" screen with the actual error
 * message and a one-click reload, instead of a silent blank page that
 * gives the person no idea what happened or what to do about it.
 *
 * React error boundaries must be class components — there is no Hooks
 * equivalent (as of React 18/19, `componentDidCatch`/
 * `getDerivedStateFromError` have no Hook form).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.boundaryName ? `: ${this.props.boundaryName}` : ''}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center py-16 px-6">
          <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl shadow-sm p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-6 h-6 text-red-500" />
            </div>
            <h1 className="text-lg font-semibold text-slate-900 mb-1.5">Something went wrong</h1>
            <p className="text-sm text-slate-500 mb-4">
              This page hit an unexpected error{this.props.boundaryName ? ` in ${this.props.boundaryName}` : ''}. Reloading almost always fixes it — your data is safe, nothing was lost.
            </p>
            <p className="text-xs text-left font-mono text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-4 break-words">
              {this.state.error.message || String(this.state.error)}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg text-sm transition"
              >
                <RotateCcw className="w-4 h-4" /> Reload Page
              </button>
              <button
                onClick={() => { window.location.href = '/dashboard'; }}
                className="flex-1 flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2.5 rounded-lg text-sm transition"
              >
                <Home className="w-4 h-4" /> Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
