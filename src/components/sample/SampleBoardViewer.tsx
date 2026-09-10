/**
 * Spec K5（跟踪清单 D1）：示例画布只读查看器（模态浮层）。
 *
 * - 内容来自 src/lib/sample-boards.ts（纯前端静态，不占用户画板配额）。
 * - 复用主画布节点组件（ChatCardNode/NoteCardNode + data.readOnly）：与属主画布渲染一致，仅禁交互。
 * - 内置 3 个示例的切换 tab；关闭按钮 + 点击遮罩关闭。
 * - 打开时上报 K4 事件 sample_view（data.persona 人群标签，非 PII）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, ReactFlowProvider, type Node, type Edge } from '@xyflow/react';
import { X } from 'lucide-react';
import { SAMPLE_BOARDS, type SampleBoard } from '../../lib/sample-boards';
import { ChatCardNode } from '../nodes/ChatCardNode';
import { NoteCardNode } from '../nodes/NoteCardNode';
import { withErrorBoundary } from '../ErrorBoundary';
import { NodeActionsContext, readOnlyNodeActions } from '../../context/NodeActionsContext';
import { trackEvent } from '../../lib/analytics';

interface SampleBoardViewerProps {
  /** 初始展示的示例下标（缺省 0） */
  initialIndex?: number;
  onClose: () => void;
}

/** 与主画布同款节点组件（技术债 #0032：同样经 withErrorBoundary 包裹），仅禁交互 */
const readOnlyNodeTypes = {
  chat: withErrorBoundary(ChatCardNode),
  note: withErrorBoundary(NoteCardNode),
};

/** 只读画布：轻量包装，切 tab 时用 key 重挂载以重置 fitView */
const ReadOnlyFlow: React.FC<{ nodes: Node[]; edges: Edge[] }> = ({ nodes, edges }) => (
  <NodeActionsContext.Provider value={readOnlyNodeActions}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={readOnlyNodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.1}
      maxZoom={1.5}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} />
    </ReactFlow>
  </NodeActionsContext.Provider>
);

export const SampleBoardViewer: React.FC<SampleBoardViewerProps> = ({ initialIndex = 0, onClose }) => {
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), SAMPLE_BOARDS.length - 1));
  const board: SampleBoard = SAMPLE_BOARDS[index];

  useEffect(() => {
    trackEvent('sample_view', { persona: board.persona });
  }, [board.persona]);

  // Esc 关闭；浮层打开时锁定背景滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const nodes = useMemo(() => board.nodes, [board]);
  const edges = useMemo(() => board.edges, [board]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[85vh] rounded-3xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b1120] shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 示例切换 tab + 关闭 */}
        <header className="flex items-center gap-2 px-4 sm:px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur">
          <div className="min-w-0 mr-2">
            <div className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">示例画布 · {board.persona}</div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">{board.title}</h2>
          </div>
          <div className="flex-1 flex items-center gap-1.5 overflow-x-auto">
            {SAMPLE_BOARDS.map((sb, i) => (
              <button
                key={sb.id}
                onClick={() => setIndex(i)}
                className={`shrink-0 px-3 py-1.5 rounded-xl text-[11px] font-medium transition-colors ${
                  i === index
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {sb.persona}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            aria-label="关闭示例画布"
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* 只读画布 */}
        <div className="flex-1 min-h-0">
          <ReactFlowProvider>
            <ReadOnlyFlow key={board.id} nodes={nodes} edges={edges} />
          </ReactFlowProvider>
        </div>

        {/* 底部说明 */}
        <footer className="px-4 sm:px-5 py-2.5 border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur text-[11px] text-slate-400 truncate">
          {board.desc}
        </footer>
      </div>
    </div>
  );
};
