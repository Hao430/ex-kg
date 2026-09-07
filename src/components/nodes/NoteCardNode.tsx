/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { StickyNote, Trash2, GripVertical, Sparkles, ArrowRight, Plus } from 'lucide-react';
import { NoteNodeData } from '../../types';
import { useNodeActions } from '../../context/NodeActionsContext';
import { Tooltip } from '../ui/Tooltip';
import { useRenderMonitor } from '../../hooks/useRenderMonitor';

export const NoteCardNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const noteData = data as unknown as NoteNodeData;
  const nodeActions = useNodeActions();
  const [content, setContent] = useState(noteData.content || '');
  const [title, setTitle] = useState(noteData.title || '思考备忘与假设');
  const renderWarning = useRenderMonitor(`NoteNode_${id}`);
  const lastAddRef = useRef<number>(0);

  const handleBlur = () => {
    nodeActions?.updateNote?.(id, content, title);
  };

  const handleBranch = () => {
    const textToExplore = content.trim() || title;
    nodeActions?.branchFromNote?.(id, textToExplore);
  };

  const handleAddNextNote = () => {
    const now = Date.now();
    if (now - lastAddRef.current < 350) return; // Prevent duplicate rapid triggers
    lastAddRef.current = now;

    if (nodeActions?.branchNewNote) {
      nodeActions.branchNewNote(id);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      handleAddNextNote();
    }
  };

  const handleDelete = () => {
    nodeActions?.deleteNode?.(id);
  };

  return (
    <div
      onKeyDown={handleKeyDown}
      tabIndex={0}
      className={`relative w-[320px] rounded-2xl border bg-amber-50/70 dark:bg-[#15110a]/90 backdrop-blur-xl p-4 shadow-[0_8px_30px_rgba(217,119,6,0.08)] dark:shadow-[0_12px_36px_rgba(0,0,0,0.55)] transition-all duration-200 cursor-grab active:cursor-grabbing focus:outline-none ${
        selected
          ? 'border-amber-500 ring-4 ring-amber-500/20 dark:ring-amber-500/30 shadow-[0_12px_36px_rgba(217,119,6,0.22)]'
          : 'border-amber-200/80 dark:border-amber-900/40 hover:border-amber-300 dark:hover:border-amber-700/60'
      }`}
    >
      {renderWarning && (
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-500 text-xs font-medium shadow-md backdrop-blur-md whitespace-nowrap z-50 animate-in fade-in slide-in-from-bottom-2">
          {renderWarning}
        </div>
      )}

      {/* Left Handle: "结论下游" (Target) */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        title="【结论下游】接收来自上游卡片的推导或结论连线"
        className="!w-3.5 !h-3.5 !bg-white dark:!bg-[#15110a] !border-2 !border-amber-500 dark:!border-amber-400 !-left-[7px] !z-20 transition-all hover:!scale-125 shadow-xs cursor-crosshair"
      />

      {/* Header with Grip & Drag indication */}
      <div className="flex items-center justify-between pb-2.5 border-b border-amber-200/70 dark:border-amber-900/50 mb-2.5 select-none">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 mr-2">
          <GripVertical className="w-3.5 h-3.5 text-amber-400/80 dark:text-amber-600 shrink-0" />
          <span className="flex items-center justify-center w-5 h-5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-400 shrink-0">
            <StickyNote className="w-3 h-3" />
          </span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="输入便签标题..."
            className="nodrag text-xs font-semibold text-amber-950 dark:text-amber-100 bg-transparent outline-none w-full truncate placeholder:text-amber-700/50 dark:placeholder:text-amber-400/40"
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip content="在后方创建并连接新便签" shortcut="Tab" side="top">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleAddNextNote();
              }}
              className="nodrag p-1 text-amber-700 dark:text-amber-400 hover:text-amber-950 dark:hover:text-amber-200 hover:bg-amber-200/60 dark:hover:bg-amber-900/50 rounded-lg transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          <Tooltip content="删除便签" side="top">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              className="nodrag p-1 text-amber-600 dark:text-amber-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-amber-200/60 dark:hover:bg-amber-900/50 rounded-lg transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Note Content Textarea */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder="记录思考沉淀、提炼核心结论或行动项（按 Tab 键自动延伸下一个相连便签）..."
        rows={5}
        className="nodrag nowheel nopan select-text w-full text-xs text-amber-950 dark:text-amber-100 placeholder:text-amber-700/50 dark:placeholder:text-amber-400/40 bg-transparent resize-none outline-none leading-relaxed font-sans"
      />

      {/* Bottom Guidance & Branch Action Bar */}
      <div className="mt-2.5 pt-2 border-t border-amber-200/60 dark:border-amber-900/50 flex items-center justify-between text-[10px] text-amber-800/80 dark:text-amber-400/80 select-none">
        <Tooltip content="左侧连线端点：作为上游结论的落脚点" side="bottom">
          <span className="flex items-center gap-1 text-[9px] text-amber-700/70 dark:text-amber-400/70 font-mono tracking-tight cursor-help">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
            结论下游
          </span>
        </Tooltip>

        {/* Quick Branch into downstream AI exploration */}
        <Tooltip content="以当前便签内容作为前置假设，右侧延伸生成一张新的 AI 对话推演卡片" side="top">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleBranch();
            }}
            className="nodrag flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 dark:bg-amber-500/20 hover:bg-amber-500/25 border border-amber-500/30 text-amber-900 dark:text-amber-200 font-semibold transition-all shadow-2xs group cursor-pointer"
          >
            <Sparkles className="w-3 h-3 text-amber-700 dark:text-amber-300 group-hover:text-amber-900 dark:group-hover:text-amber-100" />
            <span>以此假设探索</span>
            <ArrowRight className="w-3 h-3 text-amber-700 dark:text-amber-300 group-hover:translate-x-0.5 transition-transform" />
          </button>
        </Tooltip>

        <Tooltip content="右侧连线端点：连线至后续便签或 AI 卡片" side="bottom">
          <span className="flex items-center gap-1 text-[9px] text-amber-700/70 dark:text-amber-400/70 font-mono tracking-tight cursor-help">
            前置假设
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
          </span>
        </Tooltip>
      </div>

      {/* Right Handle: "前置假设" (Source) */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        title="【前置假设】按住拖拽连线至后续便签或 AI 探索卡片"
        className="!w-3.5 !h-3.5 !bg-white dark:!bg-[#15110a] !border-2 !border-amber-500 dark:!border-amber-400 !-right-[7px] !z-20 transition-all hover:!scale-125 shadow-xs cursor-crosshair"
      />
    </div>
  );
};
