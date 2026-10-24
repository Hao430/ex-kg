/**
 * Spec K5（跟踪清单 D1）：示例画布只读查看器（模态浮层）。
 *
 * - 内容来自 src/lib/sample-boards.ts（纯前端静态，不占用户画板配额）。
 * - 复用主画布节点组件（ChatCardNode/NoteCardNode + data.readOnly）：与属主画布渲染一致，仅禁交互。
 * - 内置 3 个示例的切换 tab；关闭按钮 + 点击遮罩关闭。
 * - 打开时上报 K4 事件 sample_view（data.persona 人群标签，非 PII）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { SAMPLE_BOARDS, type SampleBoard } from '../../lib/sample-boards';
import { ReadOnlyCanvas } from '../canvas/ReadOnlyCanvas';
import { Modal } from '../ui/base/Modal';
import { trackEvent } from '../../lib/analytics';

export interface SampleBoardViewerProps {
  /** 初始展示的示例下标（缺省 0） */
  initialIndex?: number;
  onClose: () => void;
}

export const SampleBoardViewer: React.FC<SampleBoardViewerProps> = ({ initialIndex = 0, onClose }) => {
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), SAMPLE_BOARDS.length - 1));
  const board: SampleBoard = SAMPLE_BOARDS[index];

  useEffect(() => {
    trackEvent('sample_view', { persona: board.persona });
  }, [board.persona]);

  // Esc 关闭与背景滚动锁定由 base/Modal 提供（引用计数，与弹窗叠开兼容）

  const nodes = useMemo(() => board.nodes, [board]);
  const edges = useMemo(() => board.edges, [board]);

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      zIndex="z-[80]"
      overlayClassName="p-3 sm:p-6"
      showCloseButton={false}
      className="max-w-5xl h-[85vh]"
      ariaLabel={`示例画布：${board.title}`}
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
          <ReadOnlyCanvas
            key={board.id}
            nodes={nodes}
            edges={edges}
            fitViewPadding={0.15}
          />
        </div>

        {/* 底部说明 */}
        <footer className="px-4 sm:px-5 py-2.5 border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur text-[11px] text-slate-400 truncate">
          {board.desc}
        </footer>
    </Modal>
  );
};
