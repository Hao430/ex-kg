/**
 * Spec K2（跟踪清单 B1）：公开只读分享页。
 *
 * 凭 shareCode 拉取快照，以 React Flow 只读画布渲染（禁拖拽/连线/选中），
 * 底部品牌条引导访客进主应用。节点复用主画布 ChatCardNode/NoteCardNode
 * （data.readOnly 隐藏交互控件 + readOnlyNodeActions 桩兜底），保证分享快照
 * 与属主画布渲染一致（工单 2026-09-10）；AuthProvider 仅为主卡片组件提供登录态上下文。
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
import { Sparkles, ArrowRight, Sun, Moon } from 'lucide-react';
import { trackEvent } from '../../lib/analytics';
import { recordCloneIntent } from '../../lib/share-clone';
import { ChatCardNode } from '../nodes/ChatCardNode';
import { NoteCardNode } from '../nodes/NoteCardNode';
import { withErrorBoundary } from '../ErrorBoundary';
import { NodeActionsContext, readOnlyNodeActions } from '../../context/NodeActionsContext';
import { AuthProvider } from '../../context/AuthContext';
import '@xyflow/react/dist/style.css';

/** 与主画布同款节点组件（技术债 #0032：同样经 withErrorBoundary 包裹），仅禁交互 */
const readOnlyNodeTypes = {
  chat: withErrorBoundary(ChatCardNode),
  note: withErrorBoundary(NoteCardNode),
};


/**
 * 主题状态：优先读 localStorage（与主应用共用 deepdive_theme 键，访客进入主应用后偏好延续），
 * 无记录时跟随系统；切换即持久化并同步 html.dark class（与 App.tsx 同口径）。
 */
function useShareTheme(): { theme: 'light' | 'dark'; toggleTheme: () => void } {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('deepdive_theme');
      if (saved === 'light' || saved === 'dark') return saved;
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch {}
    return 'light';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('deepdive_theme', theme);
    } catch {}
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  return { theme, toggleTheme };
}

const SharePageInner: React.FC<{ shareCode: string }> = ({ shareCode }) => {
  const { theme, toggleTheme } = useShareTheme();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; title: string; nodes: Node[]; edges: Edge[]; viewCount: number }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 浏览计数会话去重：同会话内刷新/回看不重复计数（K2 修复：views_count 虚高）
        let countedThisSession = false;
        try {
          const key = `deepdive_share_viewed_${shareCode}`;
          countedThisSession = sessionStorage.getItem(key) === '1';
          if (!countedThisSession) sessionStorage.setItem(key, '1');
        } catch {}
        const res = await fetch(
          `/api/shares/${encodeURIComponent(shareCode)}?countViews=${countedThisSession ? '0' : '1'}`
        );
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', message: '分享不存在或已失效' });
          return;
        }
        const body = (await res.json()) as any;
        if (cancelled) return;
        // 快照节点 → React Flow 节点：type 直通（chat/note 走主画布组件），
        // data 直通并注入 readOnly 隐藏交互控件
        const nodes: Node[] = (body.nodes || []).map((n: any) => ({
          id: n.id,
          type: (n.type || 'chat') === 'note' ? 'note' : 'chat',
          position: n.position || { x: 0, y: 0 },
          data: { ...n.data, readOnly: true },
        }));
        // 边样式直通快照（与属主编排一致），仅做形状兜底——不再硬编码覆盖
        const edges: Edge[] = (body.edges || []).map((e: any) => ({
          id: e.id || `${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle || undefined,
          targetHandle: e.targetHandle || undefined,
          type: e.type || 'default',
          animated: Boolean(e.animated),
          style: e.style || undefined,
          markerEnd: e.markerEnd || undefined,
          label: e.label || undefined,
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
    // 高度修复（2026-09-09）：必须用确定高度（h-screen + 100dvh 渐进增强）。
    // 此前 min-h-screen（height:auto）下 flex-1 子项高度对孙辈的 height:100% 是
    // 「不确定高度」，React Flow（height:100%; overflow:hidden）解析为 0，
    // 节点已渲染进 DOM 但整体被裁剪——肉眼即「画布不渲染」。
    <div
      className="h-screen bg-slate-50 dark:bg-[#070a13] flex flex-col"
      style={{ height: '100dvh' }}
    >
      {/* 顶部品牌条 */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur z-10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-slate-900 dark:text-white tracking-tight">枝想</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            id="share-theme-toggle-btn"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
            className={`p-2 rounded-xl border cursor-pointer transition-all ${
              theme === 'dark'
                ? 'bg-slate-800/90 hover:bg-slate-700 text-amber-300 border-slate-700/80 shadow-inner'
                : 'bg-slate-100 hover:bg-slate-200/80 text-slate-700 border-slate-200/80'
            }`}
          >
            {theme === 'dark' ? (
              <Moon className="w-3.5 h-3.5 text-amber-300 fill-amber-300/20" />
            ) : (
              <Sun className="w-3.5 h-3.5 text-amber-500" />
            )}
          </button>
          <a
            href="/"
            className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            前往枝想探索 →
          </a>
        </div>
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
            {/* AuthProvider：ChatCardNode 内部 useAuth 需要；访客态 user=null 即可 */}
            <AuthProvider>
              <NodeActionsContext.Provider value={readOnlyNodeActions}>
                <ReactFlowProvider>
                  <ReactFlow
                    nodes={state.nodes}
                    edges={state.edges}
                    nodeTypes={readOnlyNodeTypes}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    edgesFocusable={false}
                    zoomOnDoubleClick={false}
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
              </NodeActionsContext.Provider>
            </AuthProvider>
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
              克隆续问
              <ArrowRight className="w-3.5 h-3.5" />
            </motion.a>
          </footer>
        </>
      )}

      {/* ICP 备案链接（工信部要求：置于页面底部、可点击跳转查询系统） */}
      <footer className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur text-center shrink-0">
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
        >
          湘ICP备2025125191号-2
        </a>
      </footer>
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
