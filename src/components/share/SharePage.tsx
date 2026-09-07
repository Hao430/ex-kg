/**
 * Spec K2（跟踪清单 B1）：公开只读分享页。
 *
 * 裸页面（无 AuthProvider，同 /verify-email 分流模式）：凭 shareCode 拉取快照，
 * 以 React Flow 只读画布渲染（禁拖拽/连线/选中），底部品牌条引导访客进主应用。
 * 使用独立的轻量只读节点组件（不复用 ChatCardNode——其交互回调/配额逻辑与登录态耦合）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  type Node,
  type Edge,
} from '@xyflow/react';
import { motion } from 'framer-motion';
import { Sparkles, ArrowRight } from 'lucide-react';
import { trackEvent } from '../../lib/analytics';
import { recordCloneIntent } from '../../lib/share-clone';
import { shareNodeTypes } from './ShareReadOnlyNode';
import '@xyflow/react/dist/style.css';

/** 只读卡片节点与 nodeTypes 已抽取为共享模块 ShareReadOnlyNode.tsx（K5 示例画布复用） */


/** 主题跟随系统：给根元素挂 dark class，与主应用 Tailwind dark: 变体一致 */
function useSystemTheme(): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
}

const SharePageInner: React.FC<{ shareCode: string }> = ({ shareCode }) => {
  useSystemTheme();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; title: string; nodes: Node[]; edges: Edge[]; viewCount: number }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/shares/${encodeURIComponent(shareCode)}`);
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', message: '分享不存在或已失效' });
          return;
        }
        const body = (await res.json()) as any;
        if (cancelled) return;
        // 快照节点 → React Flow 节点（position 缺省兜底；isNote 由 type 映射）
        const nodes: Node[] = (body.nodes || []).map((n: any) => ({
          id: n.id,
          type: 'share',
          position: n.position || { x: 0, y: 0 },
          data: { ...n.data, isNote: (n.type || 'chat') === 'note' },
        }));
        const edges: Edge[] = (body.edges || []).map((e: any) => ({
          id: e.id || `${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          animated: false,
        }));
        setState({ status: 'ready', title: body.title || '枝想画板分享', nodes, edges, viewCount: body.viewCount || 0 });
        trackEvent('share_view'); // K4 事件 9：分享页浏览成功（传播链路）
      } catch {
        if (!cancelled) setState({ status: 'error', message: '加载失败，请稍后重试' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareCode]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#070a13] flex flex-col">
      {/* 顶部品牌条 */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur z-10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-slate-900 dark:text-white tracking-tight">枝想</span>
        </div>
        <a
          href="/"
          className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          前往枝想探索 →
        </a>
      </header>

      {state.status === 'loading' && (
        <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">加载中…</div>
      )}
      {state.status === 'error' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div className="text-slate-500 dark:text-slate-400 text-sm">{state.message}</div>
          <a href="/" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
            去枝想开启我的思维探索
          </a>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <div className="px-4 sm:px-5 pt-4">
            <h1 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white truncate">{state.title}</h1>
          </div>
          {/* flex-1 + min-h-0：画布占满剩余高度（移动端不引入 480px 硬兜底导致的页面滚动） */}
          <div className="flex-1 min-h-0">
            <ReactFlowProvider>
              <ReactFlow
                nodes={state.nodes}
                edges={state.edges}
                nodeTypes={shareNodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                edgesFocusable={false}
                // 移动端手势：React Flow 默认支持单指拖拽平移 + 双指捏合缩放（zoomOnPinch）
                proOptions={{ hideAttribution: true }}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.1}
                maxZoom={1.5}
              >
                <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
          {/* 底部品牌传播条：CTA 点击记录克隆意图（Spec K6/B1），注册/登录后自动克隆该画布 */}
          <footer className="px-4 sm:px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur flex items-center justify-between gap-3">
            <div className="text-[11px] text-slate-400">
              由 枝想 生成
              <span className="hidden sm:inline"> · 已被浏览 {state.viewCount} 次</span>
            </div>
            <motion.a
              href="/"
              whileHover={{ scale: 1.03 }}
              onClick={() => recordCloneIntent(shareCode)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 text-white text-xs font-semibold shadow-lg"
            >
              用 AI 深挖我的问题
              <ArrowRight className="w-3.5 h-3.5" />
            </motion.a>
          </footer>
        </>
      )}
    </div>
  );
};

/** 分享页外壳：从 URL 提取 shareCode（main.tsx 分流进入） */
export const SharePage: React.FC = () => {
  const shareCode = useMemo(() => {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }, []);
  return <SharePageInner shareCode={shareCode} />;
};
