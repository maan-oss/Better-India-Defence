import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  area?: string;
}

/** Contains rendering failures to one application area and offers recovery without a full reload. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.area ?? 'app'}]`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="err" role="alert">
        <b>{this.props.area ?? 'This area'} failed to render.</b>
        <div className="mono" style={{ marginTop: 6 }}>
          {this.state.error.message}
        </div>
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
