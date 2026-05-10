import { Component, type ErrorInfo, type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { msg: string | null }> {
  state: { msg: string | null } = { msg: null };

  static getDerivedStateFromError(e: Error): { msg: string } {
    return { msg: `${e.message}\n\n${e.stack ?? ''}`.slice(0, 4000) };
  }

  componentDidCatch(e: Error, info: ErrorInfo): void {
    console.error('[Argus]', e, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.msg) {
      return (
        <div
          className="min-h-screen bg-zinc-950 text-rose-200 p-6 font-mono text-sm whitespace-pre-wrap"
          style={{ maxWidth: '100vw' }}
        >
          <h1 className="text-lg font-semibold text-zinc-100 mb-3">Argus UI error</h1>
          <p className="text-zinc-400 mb-4 text-xs">
            Open DevTools (Console) for the full stack. Fix or hard-refresh after deploying API changes.
          </p>
          {this.state.msg}
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
