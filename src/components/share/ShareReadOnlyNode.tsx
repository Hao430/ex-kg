/**
 * Spec K2/K5 共享只读节点组件：对话卡（问题 + Markdown 答案）/ 便签卡（琥珀底）。
 * 使用方：分享页（K2）、示例画布查看器（K5/D1）——均为 React Flow 只读画布。
 */
import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';

/**
 * 只读锚点：React Flow 渲染边必须依赖节点上的 Handle 计算路径（缺失时整条边被
 * 静默丢弃，error #008）。分享画布禁止交互，故 visibility:hidden 保持几何可测量、
 * pointer-events:none 防交互；左右方位与主画布 ChatCardNode 一致。
 */
function ReadOnlyHandles(): React.ReactElement {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ visibility: 'hidden', pointerEvents: 'none' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ visibility: 'hidden', pointerEvents: 'none' }}
      />
    </>
  );
}

/** 只读快照节点数据形状（保存链路已按 I 组口径白名单化，直接渲染） */
export interface ShareNodeData {
  isNote?: boolean;
  title?: string;
  question?: string;
  answer?: string;
  noteContent?: string;
  color?: string;
}

export const ShareNode: React.FC<NodeProps> = ({ data }) => {
  const d = data as unknown as ShareNodeData;
  if (d.isNote) {
    return (
      <div className="w-[220px] sm:w-[240px] md:w-[260px] rounded-2xl border border-amber-300/70 dark:border-amber-600/50 bg-amber-50 dark:bg-amber-950/60 p-4 shadow-lg">
        <ReadOnlyHandles />
        <div className="text-xs font-bold text-amber-700 dark:text-amber-300 mb-1.5">便签</div>
        <div className="text-xs text-amber-900 dark:text-amber-100 whitespace-pre-wrap break-words leading-relaxed">
          {d.noteContent || d.title || '（空便签）'}
        </div>
      </div>
    );
  }
  return (
    <div className="w-[240px] sm:w-[270px] md:w-[300px] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 shadow-xl">
      <ReadOnlyHandles />
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

export const shareNodeTypes = { share: ShareNode };
