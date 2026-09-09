/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, ErrorInfo, ReactNode, ComponentType } from 'react';

/**
 * 技术债 #0032：React 错误边界。
 * React Flow 自定义节点渲染抛错会沿组件树冒泡导致整画布崩溃（白屏），
 * 此边界把异常拦截在最小子树：
 * - node 级：单个节点降级为占位卡片，其余节点与画布交互不受影响；
 * - canvas 级：整块画布区域降级为可刷新恢复的面板，应用其余部分仍可用。
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  variant?: 'node' | 'canvas';
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 子树渲染异常:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.variant === 'canvas') {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-[#f8fafc] dark:bg-[#070c18] z-10">
          <div className="flex flex-col items-center gap-4 px-8 py-6 rounded-2xl bg-white/95 dark:bg-[#0c1322]/95 border border-slate-200/90 dark:border-white/10 shadow-xl backdrop-blur-md max-w-md text-center">
            <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">画布显示出现问题</div>
            <div className="text-sm text-slate-500 dark:text-slate-400">内容已自动保护，你的数据不会丢失。刷新页面即可恢复。</div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="w-[320px] h-[120px] flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-amber-400/70 bg-amber-50/80 dark:bg-amber-500/5 px-4 text-center">
        <div className="text-sm font-medium text-amber-600 dark:text-amber-400">此内容显示出现问题</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">刷新页面可恢复</div>
      </div>
    );
  }
}

/** HOC：把组件包进错误边界（nodeTypes 里的自定义节点组件用 node 级） */
export function withErrorBoundary<P extends object>(
  Wrapped: ComponentType<P>,
  variant: ErrorBoundaryProps['variant'] = 'node'
) {
  const WrappedWithErrorBoundary = (props: P) => (
    <ErrorBoundary variant={variant}>
      <Wrapped {...props} />
    </ErrorBoundary>
  );
  WrappedWithErrorBoundary.displayName = `WithErrorBoundary(${Wrapped.displayName || Wrapped.name || 'Component'})`;
  return WrappedWithErrorBoundary;
}
