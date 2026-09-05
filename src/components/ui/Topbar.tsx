/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Sparkles,
  FolderOpen,
  Plus,
  Maximize2,
  LayoutGrid,
  Download,
  FileText,
  FileJson,
  StickyNote,
  RotateCcw,
  Check,
  ChevronDown,
  Compass,
  Sun,
  Moon,
} from 'lucide-react';
import { DeepDiveBoardMeta } from '../../types';

interface TopbarProps {
  boardName: string;
  onRenameBoard: (newName: string) => void;
  boards: DeepDiveBoardMeta[];
  currentBoardId: string;
  onSwitchBoard: (boardId: string) => void;
  onNewBoard: () => void;
  onAddRootNode: () => void;
  onAddNoteNode: () => void;
  onAutoLayout: () => void;
  onFitView: () => void;
  onExportJson: () => void;
  onExportMarkdown: () => void;
  onResetBoard: () => void;
  onGoToLanding?: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({
  boardName,
  onRenameBoard,
  boards,
  currentBoardId,
  onSwitchBoard,
  onNewBoard,
  onAddRootNode,
  onAddNoteNode,
  onAutoLayout,
  onFitView,
  onExportJson,
  onExportMarkdown,
  onResetBoard,
  onGoToLanding,
  theme = 'light',
  onToggleTheme,
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(boardName);
  const [showBoardMenu, setShowBoardMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const handleNameSubmit = () => {
    setIsEditingName(false);
    if (nameInput.trim()) {
      onRenameBoard(nameInput.trim());
    } else {
      setNameInput(boardName);
    }
  };

  const isDark = theme === 'dark';

  return (
    <header className="absolute top-0 left-0 right-0 h-14 bg-white/90 dark:bg-[#0c1220]/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 px-4 flex items-center justify-between z-40 shadow-xs transition-colors duration-200">
      {/* Left: Brand + Project Switcher */}
      <div className="flex items-center gap-2.5 sm:gap-3">
        <button
          onClick={onGoToLanding}
          className="flex items-center gap-2 group cursor-pointer"
          title="返回产品宣传首页"
        >
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 flex items-center justify-center text-white shadow-md shadow-blue-500/20 group-hover:scale-105 transition-transform">
            <Compass className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-slate-800 dark:text-slate-100 text-sm tracking-tight hidden sm:inline group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            DeepDive<span className="text-blue-600 dark:text-blue-400 font-normal">.ai</span>
          </span>
        </button>

        {onGoToLanding && (
          <button
            onClick={onGoToLanding}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-indigo-50/60 dark:hover:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60 transition-colors"
            title="查看产品特性与宣传落地页"
          >
            <Sparkles className="w-3 h-3 text-indigo-500 dark:text-indigo-400" />
            <span className="hidden md:inline">产品介绍</span>
          </button>
        )}

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800" />

        {/* Project Selector */}
        <div className="relative">
          <button
            onClick={() => setShowBoardMenu(!showBoardMenu)}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span className="max-w-[130px] sm:max-w-[160px] truncate">{boardName}</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {showBoardMenu && (
            <div className="absolute top-full left-0 mt-1.5 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl py-1.5 z-50 animate-in fade-in zoom-in-95">
              <div className="px-3 py-1 text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                思考画板列表
              </div>
              <div className="max-h-48 overflow-y-auto">
                {boards.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => {
                      onSwitchBoard(b.id);
                      setShowBoardMenu(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors ${
                      b.id === currentBoardId
                        ? 'text-blue-600 dark:text-blue-400 font-semibold bg-blue-50/60 dark:bg-blue-950/40'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="truncate flex-1 mr-2">{b.name}</span>
                    {b.id === currentBoardId && <Check className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />}
                  </button>
                ))}
              </div>
              <div className="border-t border-slate-100 dark:border-slate-800 mt-1 pt-1 px-1">
                <button
                  onClick={() => {
                    onNewBoard();
                    setShowBoardMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-lg transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  新建探索画板
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Inline Board Title Editing */}
        {isEditingName ? (
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={handleNameSubmit}
            onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
            autoFocus
            className="px-2 py-1 text-xs border border-blue-400 dark:border-blue-500 rounded-md outline-none bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100"
          />
        ) : (
          <span
            onClick={() => {
              setNameInput(boardName);
              setIsEditingName(true);
            }}
            title="点击重命名当前画板"
            className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer hidden md:inline"
          >
            (点击重命名)
          </span>
        )}
      </div>

      {/* Center / Right Controls */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {/* Global Dark Mode Switcher */}
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium cursor-pointer transition-all ${
              isDark
                ? 'bg-slate-800/90 hover:bg-slate-700 text-amber-300 border-slate-700/80 shadow-inner'
                : 'bg-slate-100 hover:bg-slate-200/80 text-slate-700 border-slate-200/80'
            }`}
            title={isDark ? '当前为深夜深色模式（点击切换浅色模式）' : '切换为深夜深色模式（沉浸专注）'}
          >
            {isDark ? (
              <>
                <Moon className="w-3.5 h-3.5 text-amber-300 fill-amber-300/20" />
                <span className="hidden sm:inline">深色</span>
              </>
            ) : (
              <>
                <Sun className="w-3.5 h-3.5 text-amber-500" />
                <span className="hidden sm:inline">浅色</span>
              </>
            )}
          </button>
        )}

        <button
          onClick={onAddRootNode}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-medium shadow-sm shadow-blue-500/20 transition-all hover:shadow"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建主题</span>
        </button>

        <button
          onClick={onAddNoteNode}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-medium transition-colors"
          title="添加思维便签卡片"
        >
          <StickyNote className="w-3.5 h-3.5 text-amber-500" />
          <span className="hidden md:inline">便签</span>
        </button>

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 mx-0.5" />

        <button
          onClick={onAutoLayout}
          className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-medium transition-colors"
          title="按思维树自动规整排版 (Zero-Drag Auto Layout)"
        >
          <LayoutGrid className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          <span className="hidden lg:inline">自动规整</span>
        </button>

        <button
          onClick={onFitView}
          className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors"
          title="居中适应画布 (Fit View)"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        {/* Export Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowExportMenu(!showExportMenu)}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-medium transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span className="hidden sm:inline">导出</span>
          </button>

          {showExportMenu && (
            <div className="absolute top-full right-0 mt-1.5 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl py-1.5 z-50 animate-in fade-in zoom-in-95">
              <button
                onClick={() => {
                  onExportMarkdown();
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <div>
                  <div className="font-medium">Markdown 大纲</div>
                  <div className="text-[10px] text-slate-400 dark:text-slate-500">导出为结构化研报大纲</div>
                </div>
              </button>

              <button
                onClick={() => {
                  onExportJson();
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 border-t border-slate-100 dark:border-slate-800"
              >
                <FileJson className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <div className="font-medium">JSON 完整备份</div>
                  <div className="text-[10px] text-slate-400 dark:text-slate-500">可再次导入恢复画布</div>
                </div>
              </button>
            </div>
          )}
        </div>

        <button
          onClick={onResetBoard}
          className="p-1.5 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded-xl transition-colors"
          title="重置当前画板"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
