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
  type NodeProps,
} from '@xyflow/react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { Sparkles, ArrowRight } from 'lucide-react';
import '@xyflow/react/dist/style.css';

/** 快照节点数据形状（保存链路已按 I 组口径白名单化，直接渲染） */
interface ShareNodeData {
  isNote?: boolean;
  title?: string;
  question?: string;
  answer?: string;
  noteContent?: string;
  color?: string;
}

/** 只读卡片节点：对话卡（问题 + Markdown 答案）/ 便签卡（琥珀底） */
const ShareNode: React.FC<NodeProps> = ({ data }) => {
  const d = data as unknown as ShareNodeData;
  if (d.isNote) {
    return (
      <div className="w-[260px] rounded-2xl border border-amber-300/70 dark:border-amber-600/50 bg-amber-50 dark:bg-amber-950/60 p-4 shadow-lg">
        <div className="text-xs font-bold text-amber-700 dark:text-amber-300 mb-1.5">便签</div>
        <div className="text-xs text-amber-900 dark:text-amber-100 whitespace-pre-wrap break-words leading-relaxed">
          {d.noteContent || d.title || '（空便签）'}
        </div>
      </div>
    );
  }
  return (
    <div className="w-[300px] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 shadow-xl">
      {d.question && (
        <div className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-2 break-words leading-snug">
          {d.title && d.title !== d.question && (
            <div className="text-[11px] text-slate-400 font-medium mb-0.5">{d.title}</div>
          )}
          {d.question}
        </div>
      )}
      {d.answer && (
        <div className="text-xs text-slate-600 dark:text-slate-300 prose prose-sm dark:prose-invert max-w-none break-words leading-relaxed">
          <ReactMarkdown
            components={{
              a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
            }}
          >
            {d.answer}
          </ReactMarkdown>
        </div>
      )}
      {!d.answer && !d.question && (
        <div className="text-xs text-slate-400">（暂无内容）</div>
      )}
    </div>
  );
};

const nodeTypes = { share: ShareNode };

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
          <div className="px-5 pt-4">
            <h1 className="text-lg font-bold text-slate-900 dark:text-white truncate">{state.title}</h1>
          </div>
          <div className="flex-1 min-h-[480px]">
            <ReactFlowProvider>
              <ReactFlow
                nodes={state.nodes}
                edges={state.edges}
                nodeTypes={nodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                edgesFocusable={false}
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
          {/* 底部品牌传播条（K2 v1 为静态引导；注册自动克隆列入后续迭代） */}
          <footer className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur flex items-center justify-between gap-3">
            <div className="text-[11px] text-slate-400">
              由 枝想 生成 · 已被浏览 {state.viewCount} 次
            </div>
            <motion.a
              href="/"
              whileHover={{ scale: 1.03 }}
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
