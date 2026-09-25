import './webBridge';
import React, { Component, StrictMode } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// 批次 M-2 迁移期：设计 CSS 在 styles.css 之前（同权重时旧规则赢 = 未迁移部分零视觉改动）
import './design/index.css';
import './styles.css';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[React ErrorBoundary 捕获到渲染异常]:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, color: '#e53935', fontFamily: 'system-ui, sans-serif', maxWidth: 800, margin: '40px auto', background: '#fff', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
          <h2 style={{ margin: '0 0 16px 0', borderBottom: '1px solid #ffcdd2', paddingBottom: 8 }}>⚠️ 页面加载遇到异常 (Runtime Error)</h2>
          <div style={{ background: '#ffebee', padding: 16, borderRadius: 6, fontSize: 14, fontFamily: 'monospace', marginBottom: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {this.state.error?.toString()}
          </div>
          {this.state.error?.stack && (
            <details open style={{ marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>调用栈信息 (Stack Trace)</summary>
              <pre style={{ fontSize: 12, background: '#f5f5f5', padding: 12, borderRadius: 4, overflow: 'auto', maxHeight: 300 }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '8px 20px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}
          >
            刷新重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');

if (!container) {
  throw new Error('找不到 #root 挂载点，请检查 index.html');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

