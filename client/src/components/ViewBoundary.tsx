import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ViewBoundaryProps {
  children: ReactNode;
}

interface ViewBoundaryState {
  error: Error | null;
}

/**
 * A view that fails to load or render says so.
 *
 * Both the canvas and the chat view load on demand, so anything that stops
 * their chunk importing — or throws on the first render — used to leave the
 * page black with nothing on it: no message, no hint, nothing to act on. The
 * error belongs on screen, where whoever hit it is looking.
 */
export class ViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  state: ViewBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ViewBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The component stack is the useful half and it is not worth rendering.
    console.error('A view failed to render:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-screen w-full bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-xl w-full">
          <h1 className="text-xl font-semibold text-white mb-2">This view did not load</h1>
          <p className="text-sm text-slate-400 mb-4">
            Something threw while the view was starting up. The console has the component stack.
          </p>
          <pre className="text-xs font-mono text-red-300 bg-red-950/30 border border-red-900/50 rounded p-3 whitespace-pre-wrap break-words mb-4">
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-slate-800 border border-slate-700 rounded text-sm text-slate-200 hover:border-blue-500 transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
