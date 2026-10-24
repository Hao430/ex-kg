/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  Plus,
  Maximize2,
  LayoutGrid,
  FileText,
  FileJson,
  FileUp,
  ImageDown,
  StickyNote,
  RotateCcw,
  Cloud,
  CloudOff,
  MoreHorizontal,
  AlertTriangle,
  Network,
  Link2,
  Search,
} from 'lucide-react';
import { DeepDiveBoardMeta } from '../../types';
import type { FolderMeta } from '../../lib/folder-store';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { Tooltip } from './Tooltip';
import { useClickOutside } from '../../hooks/useClickOutside';
import {
  NodeSearchDialog,
  BoardSelectorDropdown,
  UserDropdown,
  BrandLogo,
  ProductSwitchPill,
  VipBadge,
  ThemeToggleButton,
} from './topbar';

export interface TopbarProps {
  boardName: string;
  onRenameBoard: (newName: string) => void;
  boards: DeepDiveBoardMeta[];
  /** Spec L1：分组（下拉按分组渲染小标题；空数组则扁平列表） */
  folders?: FolderMeta[];
  currentBoardId: string;
  onSwitchBoard: (boardId: string) => void;
  onNewBoard: () => void;
  onDeleteBoard: (boardId: string) => void;
  onAddRootNode: () => void;
  onAddNoteNode: () => void;
  onAutoLayout: () => void;
  onFitView: () => void;
  /** 节点搜索结果跳转：聚焦并高亮该节点（画布内检索，Spec O1） */
  onSearchResultClick?: (nodeId: string) => void;
  onExportJson: () => void;
  /** Spec M1：导入已导出的 JSON 备份为新画板 */
  onImportJson: (file: File) => void;
  onExportMarkdown: () => void;
  onExportPng: () => void;
  /** 生成本画板的只读分享链接（Spec K2） */
  onShareLink?: () => void;
  onResetBoard: () => void;
  onGoToLanding?: () => void;
  /** 打开示例画布查看器（Spec K5/D1 冷启动引导） */
  onOpenSamples?: () => void;
  /** 打开画板库（Spec L1：搜索/收藏/归档） */
  onOpenLibrary?: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  nodeCount?: number;
  /** 服务端同步状态指示（Spec A5） */
  syncState?: 'idle' | 'saved' | 'pending' | 'error' | 'conflict';
  /** 网络不可达。与 syncState 分开：离线时同步状态可能还停在 idle/pending，但「存不下」是事实 */
  offline?: boolean;
  /**
   * Spec Q1：本画板是否保留探索灵感节点（画板级状态，跟着画板走）。
   */
  suggestionsEnabled?: boolean;
  /**
   * 共享默认画板（legacy）不支持画板级设置
   */
  suggestionsToggleDisabled?: boolean;
  onToggleSuggestions?: () => void;
  /** Spec R1：当前产品模式 ('canvas' | 'practice') */
  activeProduct?: 'canvas' | 'practice';
  /** 切换产品 */
  onSwitchProduct?: (product: 'canvas' | 'practice') => void;
  /** 是否开启练习功能 */
  quizEnabled?: boolean;
}

export const Topbar: React.FC<TopbarProps> = ({
  boardName,
  onRenameBoard,
  boards,
  folders = [],
  currentBoardId,
  onSwitchBoard,
  onNewBoard,
  onDeleteBoard,
  onAddRootNode,
  onAddNoteNode,
  onAutoLayout,
  onFitView,
  onSearchResultClick,
  onExportJson,
  onImportJson,
  onExportMarkdown,
  onExportPng,
  onShareLink,
  onResetBoard,
  onGoToLanding,
  onOpenSamples,
  onOpenLibrary,
  theme = 'light',
  onToggleTheme,
  nodeCount,
  syncState = 'idle',
  offline = false,
  suggestionsEnabled = true,
  suggestionsToggleDisabled = false,
  onToggleSuggestions,
  activeProduct = 'canvas',
  onSwitchProduct,
  quizEnabled = true,
}) => {
  const [showCanvasMoreMenu, setShowCanvasMoreMenu] = useState(false);
  const [showSearchMenu, setShowSearchMenu] = useState(false);

  const importInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const canvasMoreMenuRef = useRef<HTMLDivElement>(null);

  const { user, isVip } = useAuth();
  const { openRechargeModal } = useModal();
  const isDark = theme === 'dark';

  // 画布更多操作菜单：点击外部与 Escape 监听
  useClickOutside({
    refs: [canvasMoreMenuRef],
    enabled: showCanvasMoreMenu,
    onOutside: () => setShowCanvasMoreMenu(false),
    closeOnEscape: true,
  });

  return (
    <header className="absolute top-0 left-0 right-0 h-14 bg-white/80 dark:bg-[#070b14]/85 backdrop-blur-xl border-b border-slate-200/70 dark:border-slate-800/70 px-3 sm:px-4 flex items-center justify-between z-40 shadow-[0_4px_20px_rgba(0,0,0,0.03)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.4)] transition-colors duration-200 select-none">
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onImportJson(file);
        }}
      />

      {/* ================= ZONE 1: Left - Brand & Board Identity ================= */}
      <div className="flex items-center gap-2 xl:gap-3 shrink-0">
        {/* Brand Logo（共享组件） */}
        <BrandLogo onGoToLanding={onGoToLanding} />

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 hidden sm:block" />

        {/* Spec R1: 双产品切换胶囊（思维画布 ↔ AI 练习，共享组件） */}
        {quizEnabled && (
          <ProductSwitchPill activeProduct={activeProduct} onSwitchProduct={onSwitchProduct} />
        )}

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 hidden sm:block" />

        {/* Sync Status Indicator (Spec A5) */}
        <Tooltip
          content={
            !user ? '本地画板，未开启云端同步' :
            offline ? '当前无网络，改动暂时无法保存到云端' :
            syncState === 'pending' ? '正在保存到云端…' :
            syncState === 'error' ? '有改动尚未保存到云端（已停止自动重试）' :
            syncState === 'conflict' ? '有改动尚未保存到云端（画板已在其他窗口被修改）' :
            '已同步到云端'
          }
          side="bottom"
        >
          <span
            data-testid="sync-indicator"
            aria-label={`同步状态：${!user ? 'local' : offline ? 'offline' : syncState}`}
            className={`hidden md:flex items-center justify-center w-7 h-7 rounded-lg cursor-default ${
              !user
                ? 'text-slate-400 dark:text-slate-500'
                : offline || syncState === 'error' || syncState === 'conflict'
                ? 'text-rose-500'
                : syncState === 'pending'
                ? 'text-slate-400 dark:text-slate-500'
                : 'text-emerald-500'
            }`}
          >
            {!user ? (
              <CloudOff className="w-4 h-4" />
            ) : (
              <Cloud
                className={`w-4 h-4 ${syncState === 'pending' ? 'animate-pulse' : ''}`}
              />
            )}
          </span>
        </Tooltip>

        {/* 子模块 1: 画板选择与重命名 */}
        <BoardSelectorDropdown
          boardName={boardName}
          boards={boards}
          folders={folders}
          currentBoardId={currentBoardId}
          onRenameBoard={onRenameBoard}
          onSwitchBoard={onSwitchBoard}
          onDeleteBoard={onDeleteBoard}
          onNewBoard={onNewBoard}
          onOpenSamples={onOpenSamples}
          onOpenLibrary={onOpenLibrary}
        />

        {/* 新建画板直达快捷入口 */}
        <Tooltip content="新建思考画板" side="bottom">
          <button
            onClick={onNewBoard}
            className="hidden lg:flex items-center gap-1 px-2 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-medium shadow-sm transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden 2xl:inline">新建画板</span>
          </button>
        </Tooltip>

        {/* 画板库直达快捷入口 */}
        {onOpenLibrary && (
          <Tooltip content="画板库（搜索 / 收藏 / 归档）" side="bottom">
            <button
              onClick={onOpenLibrary}
              className="hidden lg:flex items-center gap-1 px-2 py-1.5 rounded-xl bg-slate-100/70 dark:bg-slate-800/60 hover:bg-slate-200/70 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200 text-xs font-medium border border-slate-200/50 dark:border-slate-700/50 transition-colors cursor-pointer"
            >
<LayoutGrid className="w-3.5 h-3.5" />
            <span className="hidden 2xl:inline">画板库</span>
            </button>
          </Tooltip>
        )}

        {/* 灵感开关 (Spec Q1) */}
        {onToggleSuggestions && (
          <Tooltip
            content={
              suggestionsToggleDisabled
                ? '共享默认画板不支持该设置'
                : suggestionsEnabled
                ? '关闭后会清理本画板上的灵感节点，且不再生成（删除后不可恢复）'
                : '开启后本画板的新回答会附带灵感节点'
            }
            side="bottom"
          >
            <div className="hidden xl:flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-xl bg-slate-100/70 dark:bg-slate-800/60 border border-slate-200/50 dark:border-slate-700/50">
              <Sparkles className="w-3 h-3 text-indigo-500 dark:text-indigo-400 shrink-0" />
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 hidden 2xl:inline">
                灵感
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={suggestionsEnabled}
                aria-label={suggestionsEnabled ? '关闭灵感并清理本画板的灵感节点' : '开启本画板的灵感节点'}
                data-testid="suggestions-toggle"
                disabled={suggestionsToggleDisabled}
                onClick={onToggleSuggestions}
                className={`relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
                  suggestionsToggleDisabled
                    ? 'opacity-40 cursor-not-allowed'
                    : 'cursor-pointer'
                } ${suggestionsEnabled ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-600'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                    suggestionsEnabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </Tooltip>
        )}

        {/* 节点用量与性能告警 */}
        {typeof nodeCount === 'number' && (
          <>
            {nodeCount >= 150 ? (
              <Tooltip
                content={`当前画板包含 ${nodeCount} 个节点（达到大画板阈值）。为保持极致流畅度与低延迟渲染，建议点击卡片右上角「导出分支」将子分支拆分为独立画板。`}
                side="bottom"
              >
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-xl bg-amber-500/15 dark:bg-amber-500/20 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-xs font-semibold shadow-2xs cursor-help animate-pulse">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span>{nodeCount} 节点</span>
                  <span className="hidden xl:inline text-xxs font-normal px-1 py-0.2 rounded bg-amber-200/60 dark:bg-amber-900/60 text-amber-800 dark:text-amber-200">
                    建议导出分支
                  </span>
                </div>
              </Tooltip>
            ) : (
              <Tooltip
                content={`当前思考画板共包含 ${nodeCount} 个节点 (AI 思维卡片与便签)`}
                side="bottom"
              >
                <div className="hidden 2xl:flex items-center gap-1.5 px-2 py-1 rounded-xl bg-slate-100/80 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60 text-slate-500 dark:text-slate-400 text-xs font-medium cursor-default">
                  <Network className="w-3 h-3 text-slate-400 dark:text-slate-500 shrink-0" />
                  <span>{nodeCount}</span>
                  <span className="text-xxs text-slate-400 dark:text-slate-500">节点</span>
                </div>
              </Tooltip>
            )}
          </>
        )}
      </div>

      {/* ================= ZONE 2: Center - Unified Canvas Action Pill ================= */}
      <div className="flex items-center shrink-0 bg-slate-100/80 dark:bg-slate-900/80 p-1 rounded-2xl border border-slate-200/70 dark:border-slate-800 shadow-2xs backdrop-blur-md whitespace-nowrap">
        {/* 新建核心主题 */}
        <Tooltip content="新建核心主题探索节点" shortcut="Alt+N" side="bottom">
          <button
            onClick={onAddRootNode}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs shadow-indigo-500/25 transition-all cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">新建主题</span>
            <span className="lg:hidden">主题</span>
          </button>
        </Tooltip>

        {/* 添加便签 */}
        <Tooltip content="添加自由便签记事卡片" shortcut="Alt+M" side="bottom">
          <button
            onClick={onAddNoteNode}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-medium transition-colors cursor-pointer ml-1"
          >
            <StickyNote className="w-3.5 h-3.5 text-amber-500" />
            <span className="hidden 2xl:inline">便签</span>
          </button>
        </Tooltip>

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 mx-1 hidden sm:block" />

        {/* 子模块 2: 节点全文搜索浮层 */}
        <div className="relative">
          <Tooltip content="搜索当前画板内的节点" side="bottom">
            <button
              ref={searchTriggerRef}
              id="topbar-node-search-btn"
              onClick={() => setShowSearchMenu((prev) => !prev)}
              className="p-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors cursor-pointer flex items-center"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          <NodeSearchDialog
            isOpen={showSearchMenu}
            onClose={() => setShowSearchMenu(false)}
            currentBoardId={currentBoardId}
            onSelectNode={onSearchResultClick}
            triggerRef={searchTriggerRef}
          />
        </div>

        {/* 自动规整 */}
        <Tooltip content="按思维树关系自动规整排版 (Zero-Drag)" shortcut="Alt+L" side="bottom">
          <button
            onClick={onAutoLayout}
            className="p-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors cursor-pointer hidden lg:flex items-center gap-1 text-xs"
          >
            <LayoutGrid className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span className="hidden 2xl:inline text-slate-700 dark:text-slate-200">规整</span>
          </button>
        </Tooltip>

        {/* 全图视野居中自适应 */}
        <Tooltip content="全图视野居中自适应 (Fit View)" shortcut="Space" side="bottom">
          <button
            onClick={onFitView}
            className="p-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors cursor-pointer hidden lg:flex"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </Tooltip>

        {/* 画板更多操作下拉 */}
        <div ref={canvasMoreMenuRef} className="relative">
          <Tooltip content="画板导出与更多操作" side="bottom">
            <button
              onClick={() => setShowCanvasMoreMenu(!showCanvasMoreMenu)}
              className="p-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors cursor-pointer flex items-center"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          {showCanvasMoreMenu && (
            <div className="absolute top-full right-0 mt-2 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] p-1.5 z-50 animate-in fade-in zoom-in-95">
              <div className="px-2.5 py-1 text-xxs font-semibold text-slate-400 uppercase tracking-wider">
                画布与导出
              </div>

              {/* 移动端快捷操作（顶栏隐藏 Fit/规整按钮的宽度段） */}
              <div className="lg:hidden border-b border-slate-100 dark:border-slate-800 pb-1 mb-1">
                <button
                  onClick={() => {
                    onAutoLayout();
                    setShowCanvasMoreMenu(false);
                  }}
                  className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
                >
                  <LayoutGrid className="w-3.5 h-3.5 text-slate-500" />
                  <span>自动规整排版</span>
                </button>
                <button
                  onClick={() => {
                    onFitView();
                    setShowCanvasMoreMenu(false);
                  }}
                  className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
                >
                  <Maximize2 className="w-3.5 h-3.5 text-slate-500" />
                  <span>居中视野</span>
                </button>
              </div>

              <button
                onClick={() => {
                  onShareLink?.();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
              >
                <Link2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <div className="font-medium">分享链接</div>
                  <div className="text-xxs text-slate-400">生成只读分享页，访客可一键克隆</div>
                </div>
              </button>

              <button
                onClick={() => {
                  onExportPng();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
              >
                <ImageDown className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                <div>
                  <div className="font-medium">导出 PNG 图片</div>
                  <div className="text-xxs text-slate-400">可分享的思维全景图（含水印）</div>
                </div>
              </button>

              <button
                onClick={() => {
                  onExportMarkdown();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
              >
                <FileText className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <div className="font-medium">导出 Markdown</div>
                  <div className="text-xxs text-slate-400">结构化研报与思维大纲</div>
                </div>
              </button>

              <button
                onClick={() => {
                  onExportJson();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
              >
                <FileJson className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div>
                  <div className="font-medium">导出 JSON 备份</div>
                  <div className="text-xxs text-slate-400">完整节点与思维连接状态</div>
                </div>
              </button>

              <button
                onClick={() => {
                  setShowCanvasMoreMenu(false);
                  importInputRef.current?.click();
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
              >
                <FileUp className="w-4 h-4 text-cyan-600 dark:text-cyan-400 shrink-0" />
                <div>
                  <div className="font-medium">导入 JSON 备份</div>
                  <div className="text-xxs text-slate-400">从已导出的备份恢复为新画板</div>
                </div>
              </button>

              <div className="border-t border-slate-100 dark:border-slate-800 my-1" />

              <button
                onClick={() => {
                  setShowCanvasMoreMenu(false);
                  onResetBoard();
                }}
                className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                <span>重置当前画板</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ================= ZONE 3: Right - System & User Profile ================= */}
      <div className="flex items-center gap-2 shrink-0">
        {/* VIP 徽章 / 升级按钮（共享组件） */}
        {user ? (
          <VipBadge
            isVip={isVip}
            sourceVip="VIP 会员特权管理"
            sourceUpgrade="升级 VIP 会员解锁全部特权"
            onOpen={openRechargeModal}
          />
        ) : null}

        {/* 主题切换按钮（共享组件） */}
        {onToggleTheme && (
          <ThemeToggleButton isDark={isDark} onToggle={onToggleTheme} className="hidden md:block" />
        )}

        {/* 子模块 3: 用户中心与快捷入口下拉 */}
        <UserDropdown
          onGoToLanding={onGoToLanding}
        />
      </div>
    </header>
  );
};
