/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { StickyNote, Trash2, GripVertical, Sparkles, ArrowRight } from 'lucide-react';
import { NoteNodeData } from '../../types';
import { useNodeActions } from '../../context/NodeActionsContext';

export const NoteCardNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const noteData = data as unknown as NoteNodeData;
  const nodeActions = useNodeActions();
  const [content, setContent] = useState(noteData.content || '');
  const [title, setTitle] = useState(noteData.title || '思考备忘与假设');

  const handleBlur = () => {
    if (nodeActions?.updateNote) {
      nodeActions.updateNote(id, content, title);
    } else {
      noteData.onUpdate?.(id, content, title);
    }
  };

  const handleBranch = () => {
    const textToExplore = content.trim() || title;
    if (nodeActions?.branchFromNote) {
      nodeActions.branchFromNote(id, textToExplore);
    } else {
      noteData.onBranchFromNote?.(id, textToExplore);
    }
  };

  const handleDelete = () => {
    if (nodeActions?.deleteNode) {
      nodeActions.deleteNode(id);
    } else {
      noteData.onDelete?.(id);
    }
  };

  return (
    <div
      className={`relative w-[320px] rounded-2xl border bg-amber-50/90 dark:bg-[#1a160d]/95 backdrop-blur-xs p-4 shadow-lg transition-all duration-200 cursor-grab active:cursor-grabbing ${
        selected
          ? 'border-amber-500 ring-4 ring-amber-400/30 dark:ring-amber-500/20 shadow-amber-500/20'
          : 'border-amber-200/90 dark:border-amber-900/60 shadow-slate-200/50 dark:shadow-black/50 hover:border-amber-400 dark:hover:border-amber-600'
      }`}
    >
      {/* Left Handle: "结论下游" (Target) */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        title="【结论下游】接收来自上游卡片的推导或结论连线"
        className="!w-4 !h-4 !bg-amber-500 !border-2 !border-white dark:!border-slate-900 !-left-[8px] transition-all hover:!scale-150 hover:!bg-amber-600 shadow-sm cursor-crosshair"
      />

      {/* Header with Grip & Drag indication */}
      <div className="flex items-center justify-between pb-2 border-b border-amber-200/70 dark:border-amber-900/60 mb-2 select-none">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 mr-2">
          <GripVertical className="w-3.5 h-3.5 text-amber-400/80 dark:text-amber-600 shrink-0" />
          <StickyNote className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400 shrink-0" />
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleBlur}
            placeholder="输入便签标题..."
            className="nodrag text-xs font-semibold text-amber-950 dark:text-amber-100 bg-transparent outline-none w-full truncate placeholder:text-amber-700/50 dark:placeholder:text-amber-400/40"
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDelete();
            }}
            className="nodrag p-1 text-amber-600 dark:text-amber-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-amber-200/60 dark:hover:bg-amber-900/50 rounded transition-colors"
            title="删除便签"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Note Content Textarea */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={handleBlur}
        placeholder="记录思考沉淀、提炼核心结论或行动项..."
        rows={5}
        className="nodrag nowheel w-full text-xs text-amber-950 dark:text-amber-100 placeholder:text-amber-700/50 dark:placeholder:text-amber-400/40 bg-transparent resize-none outline-none leading-relaxed font-sans"
      />

      {/* Bottom Guidance & Branch Action Bar */}
      <div className="mt-2 pt-2 border-t border-amber-200/60 dark:border-amber-900/50 flex items-center justify-between text-[10px] text-amber-800/80 dark:text-amber-400/80 select-none">
        <span className="flex items-center gap-1 text-[9px] text-amber-700/70 dark:text-amber-400/70 font-mono tracking-tight">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
          结论下游
        </span>

        {/* Quick Branch into downstream AI exploration */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleBranch();
          }}
          className="nodrag flex items-center gap-1 px-2 py-1 rounded-md bg-amber-200/80 dark:bg-amber-900/60 hover:bg-amber-300/90 dark:hover:bg-amber-800/80 text-amber-900 dark:text-amber-200 font-medium transition-colors shadow-2xs group"
          title="以当前便签内容作为前置假设，右侧延伸生成一张新的 AI 对话推演卡片"
        >
          <Sparkles className="w-2.5 h-2.5 text-amber-700 dark:text-amber-300 group-hover:text-amber-900 dark:group-hover:text-amber-100" />
          <span>以此假设探索</span>
          <ArrowRight className="w-2.5 h-2.5 text-amber-700 dark:text-amber-300 group-hover:translate-x-0.5 transition-transform" />
        </button>

        <span className="flex items-center gap-1 text-[9px] text-amber-700/70 dark:text-amber-400/70 font-mono tracking-tight">
          前置假设
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
        </span>
      </div>

      {/* Right Handle: "前置假设" (Source) */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        title="【前置假设】按住拖拽连线至后续 AI 探索卡片，作为其前置认知与假设"
        className="!w-4 !h-4 !bg-amber-500 !border-2 !border-white dark:!border-slate-900 !-right-[8px] transition-all hover:!scale-150 hover:!bg-amber-600 shadow-sm cursor-crosshair"
      />
    </div>
  );
};
