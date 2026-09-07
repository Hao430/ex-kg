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
  Cloud,
  CloudOff,
  Compass,
  Sun,
  Moon,
  ShieldAlert,
  LogIn,
  LogOut,
  MoreHorizontal,
  Pencil,
  AlertTriangle,
  Network,
  Crown,
  User,
  MessageSquarePlus,
  Settings,
  Trash2,
} from 'lucide-react';
import { DeepDiveBoardMeta } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { Tooltip } from './Tooltip';

interface TopbarProps {
  boardName: string;
  onRenameBoard: (newName: string) => void;
  boards: DeepDiveBoardMeta[];
  currentBoardId: string;
  onSwitchBoard: (boardId: string) => void;
  onNewBoard: () => void;
  onDeleteBoard: (boardId: string) => void;
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
  nodeCount?: number;
  /** 服务端同步状态指示（Spec A5） */
  syncState?: 'idle' | 'saved' | 'pending' | 'error' | 'conflict';
}

export const Topbar: React.FC<TopbarProps> = ({
  boardName,
  onRenameBoard,
  boards,
  currentBoardId,
  onSwitchBoard,
  onNewBoard,
  onDeleteBoard,
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
  nodeCount,
  syncState = 'idle',
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(boardName);
  const [showBoardMenu, setShowBoardMenu] = useState(false);
  const [showCanvasMoreMenu, setShowCanvasMoreMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const {
    user,
    isVip,
    openAuthModal,
    openRechargeModal,
    openUserProfileModal,
    openFeedbackModal,
    openAdminModal,
    logout,
  } = useAuth();

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
    <header className="absolute top-0 left-0 right-0 h-14 bg-white/80 dark:bg-[#070b14]/85 backdrop-blur-xl border-b border-slate-200/70 dark:border-slate-800/70 px-3 sm:px-4 flex items-center justify-between z-40 shadow-[0_4px_20px_rgba(0,0,0,0.03)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.4)] transition-colors duration-200 select-none">
      {/* ================= ZONE 1: Left - Brand & Board Identity ================= */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {/* Brand Logo */}
        <Tooltip content="返回产品介绍首页" side="bottom">
          <button
            onClick={onGoToLanding}
            className="flex items-center gap-2 group cursor-pointer focus:outline-none"
          >
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-sky-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 group-hover:scale-105 transition-transform">
              <Compass className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-slate-850 dark:text-slate-100 text-sm tracking-tight hidden sm:inline group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              枝想<span className="text-indigo-600 dark:text-indigo-400 font-semibold">Arborize</span>
            </span>
          </button>
        </Tooltip>

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800" />

        {/* Sync Status Indicator (Spec A5)：云图标态 —— 斜杠云=本地模式，灰云=待同步，绿云=已同步，红云=失败/冲突 */}
        <Tooltip
          content={
            !user ? '本地画板，未开启云端同步' :
            syncState === 'pending' ? '待同步（离线或稍后自动补传）' :
            syncState === 'error' ? '同步失败，已停止自动重试' :
            syncState === 'conflict' ? '版本冲突：画板已在其他窗口被修改' :
            '已同步到云端'
          }
          side="bottom"
        >
          <span
            data-testid="sync-indicator"
            aria-label={`同步状态：${!user ? 'local' : syncState}`}
            className={`flex items-center justify-center w-7 h-7 rounded-lg cursor-default ${
              !user || syncState === 'pending'
                ? 'text-slate-400 dark:text-slate-500'
                : syncState === 'error' || syncState === 'conflict'
                ? 'text-red-500'
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

        {/* Board Switcher & Quick Rename */}
        <div className="relative flex items-center">
          {isEditingName ? (
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
              autoFocus
              className="px-2.5 py-1 text-xs font-medium border border-indigo-500 rounded-lg outline-none bg-white dark:bg-slate-900 text-slate-850 dark:text-slate-100 max-w-[140px] sm:max-w-[200px]"
            />
          ) : (
            <div className="flex items-center gap-1 bg-slate-100/70 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl p-0.5 pl-2 transition-colors border border-slate-200/50 dark:border-slate-700/50">
              <Tooltip content={`当前画板: ${boardName}（点击切换）`} side="bottom">
                <button
                  onClick={() => setShowBoardMenu(!showBoardMenu)}
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 py-1 pr-1 cursor-pointer focus:outline-none"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span className="max-w-[90px] sm:max-w-[150px] truncate">{boardName}</span>
                  <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
                </button>
              </Tooltip>

              <Tooltip content="重命名当前画板" side="bottom">
                <button
                  onClick={() => {
                    setNameInput(boardName);
                    setIsEditingName(true);
                  }}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>
              </Tooltip>
            </div>
          )}

          {/* Board Dropdown Menu */}
          {showBoardMenu && (
            <div className="absolute top-full left-0 mt-2 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] py-2 z-50 animate-in fade-in zoom-in-95">
              <div className="px-3 py-1 text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                思考画板列表
              </div>
              <div className="max-h-52 overflow-y-auto mt-1">
                {boards.map((b) => (
                  <div
                    key={b.id}
                    onClick={() => {
                      onSwitchBoard(b.id);
                      setShowBoardMenu(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors cursor-pointer ${
                      b.id === currentBoardId
                        ? 'text-indigo-600 dark:text-indigo-400 font-semibold bg-indigo-50/60 dark:bg-indigo-950/40'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="truncate flex-1 mr-2">{b.name}</span>
                    <span className="flex items-center gap-0.5 shrink-0">
                      {b.id === currentBoardId && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                      {b.id !== 'default-board' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteBoard(b.id);
                            setShowBoardMenu(false);
                          }}
                          aria-label={`删除画板 ${b.name}`}
                          className="p-1 rounded-lg text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-100 dark:border-slate-800 mt-1.5 pt-1.5 px-2">
                <button
                  onClick={() => {
                    onNewBoard();
                    setShowBoardMenu(false);
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-indigo-600 dark:text-indigo-400 font-medium hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-xl transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  新建思考画板
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 新建画板直达入口：不再藏于画板下拉，降低认知负担 */}
        <Tooltip content="新建思考画板" side="bottom">
          <button
            onClick={onNewBoard}
            className="flex items-center gap-1 px-2 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-medium shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden md:inline">新建画板</span>
          </button>
        </Tooltip>

        {/* Micro Stats UI: Current Canvas Total Nodes & Performance Alert */}
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
                  <span className="hidden xl:inline text-[10px] font-normal px-1 py-0.2 rounded bg-amber-200/60 dark:bg-amber-900/60 text-amber-800 dark:text-amber-200">
                    建议导出分支
                  </span>
                </div>
              </Tooltip>
            ) : (
              <Tooltip
                content={`当前思考画板共包含 ${nodeCount} 个节点 (AI 思维卡片与便签)`}
                side="bottom"
              >
                <div className="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded-xl bg-slate-100/80 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60 text-slate-500 dark:text-slate-400 text-xs font-medium cursor-default">
                  <Network className="w-3 h-3 text-slate-400 dark:text-slate-500 shrink-0" />
                  <span>{nodeCount}</span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">节点</span>
                </div>
              </Tooltip>
            )}
          </>
        )}
      </div>

      {/* ================= ZONE 2: Center - Unified Canvas Action Pill ================= */}
      <div className="flex items-center bg-slate-100/80 dark:bg-slate-900/80 p-1 rounded-2xl border border-slate-200/70 dark:border-slate-800 shadow-2xs backdrop-blur-md">
        {/* Primary Action: Add Root Topic */}
        <Tooltip content="新建核心主题探索节点" shortcut="Alt+N" side="bottom">
          <button
            onClick={onAddRootNode}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs shadow-indigo-500/25 transition-all cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">新建主题</span>
            <span className="sm:hidden">主题</span>
          </button>
        </Tooltip>

        {/* Add Note Card */}
        <Tooltip content="添加自由便签记事卡片" shortcut="Alt+M" side="bottom">
          <button
            onClick={onAddNoteNode}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-medium transition-colors cursor-pointer ml-1"
          >
            <StickyNote className="w-3.5 h-3.5 text-amber-500" />
            <span className="hidden md:inline">便签</span>
          </button>
        </Tooltip>

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 mx-1 hidden sm:block" />

        {/* Auto Layout */}
        <Tooltip content="按思维树关系自动规整排版 (Zero-Drag)" shortcut="Alt+L" side="bottom">
          <button
            onClick={onAutoLayout}
            className="p-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors cursor-pointer hidden sm:flex items-center gap-1 text-xs"
          >
            <LayoutGrid className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span className="hidden lg:inline text-slate-700 dark:text-slate-200">规整</span>
          </button>
        </Tooltip>

        {/* Fit View */}
        <Tooltip content="全图视野居中自适应 (Fit View)" shortcut="Space" side="bottom">
          <button
            onClick={onFitView}
            className="p-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors cursor-pointer hidden sm:flex"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </Tooltip>

        {/* Canvas More Operations Dropdown (Export, Reset, Layout on mobile) */}
        <div className="relative">
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
              <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                画布与导出
              </div>

              {/* Mobile quick actions if hidden from toolbar */}
              <div className="sm:hidden border-b border-slate-100 dark:border-slate-800 pb-1 mb-1">
                <button
                  onClick={() => {
                    onAutoLayout();
                    setShowCanvasMoreMenu(false);
                  }}
                  className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl"
                >
                  <LayoutGrid className="w-3.5 h-3.5 text-slate-500" />
                  <span>自动规整排版</span>
                </button>
                <button
                  onClick={() => {
                    onFitView();
                    setShowCanvasMoreMenu(false);
                  }}
                  className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl"
                >
                  <Maximize2 className="w-3.5 h-3.5 text-slate-500" />
                  <span>居中视野</span>
                </button>
              </div>

              <button
                onClick={() => {
                  onExportMarkdown();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
              >
                <FileText className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <div className="font-medium">导出 Markdown</div>
                  <div className="text-[10px] text-slate-400">结构化研报与思维大纲</div>
                </div>
              </button>

              <button
                onClick={() => {
                  onExportJson();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
              >
                <FileJson className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div>
                  <div className="font-medium">导出 JSON 备份</div>
                  <div className="text-[10px] text-slate-400">完整节点与思维连接状态</div>
                </div>
              </button>

              <div className="border-t border-slate-100 dark:border-slate-800 my-1" />

              <button
                onClick={() => {
                  setShowCanvasMoreMenu(false);
                  onResetBoard();
                }}
                className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl transition-colors"
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
        {/* VIP Status Badge / Upgrade Button */}
        {user ? (
          isVip ? (
            <Tooltip content="尊享 Pro VIP 会员特权（无限画板与无限推演）" side="bottom">
              <button
                id="topbar-vip-badge-btn"
                onClick={() => openRechargeModal('VIP 会员特权管理')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-gradient-to-r from-amber-500/15 via-amber-400/10 to-amber-500/15 hover:from-amber-500/25 hover:to-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-300/80 dark:border-amber-700/80 text-xs font-semibold transition-all cursor-pointer shadow-2xs"
              >
                <Crown className="w-3.5 h-3.5 text-amber-500 fill-amber-500/30 shrink-0" />
                <span className="font-bold tracking-tight">VIP</span>
                <span className="text-[10px] font-normal opacity-85 hidden sm:inline text-amber-600 dark:text-amber-400">
                  尊享版
                </span>
                <Sparkles className="w-2.5 h-2.5 text-amber-500 shrink-0 ml-0.5 animate-pulse" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="升级至 Pro VIP 会员，解锁无限画板与无限制思考节点" side="bottom">
              <button
                id="topbar-upgrade-vip-btn"
                onClick={() => openRechargeModal('升级 VIP 会员解锁全部特权')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white text-xs font-semibold transition-all cursor-pointer shadow-xs hover:shadow-md"
              >
                <Crown className="w-3.5 h-3.5 text-amber-200 shrink-0" />
                <span>升级 VIP</span>
              </button>
            </Tooltip>
          )
        ) : null}

        {/* Minimalist Theme Toggle Icon */}
        {onToggleTheme && (
          <Tooltip content={isDark ? '切换浅色模式' : '切换沉浸深色模式'} side="bottom">
            <button
              id="topbar-theme-toggle-btn"
              onClick={onToggleTheme}
              className={`p-2 rounded-xl border text-xs font-medium cursor-pointer transition-all ${
                isDark
                  ? 'bg-slate-800/90 hover:bg-slate-700 text-amber-300 border-slate-700/80 shadow-inner'
                  : 'bg-slate-100 hover:bg-slate-200/80 text-slate-700 border-slate-200/80'
              }`}
            >
              {isDark ? (
                <Moon className="w-3.5 h-3.5 text-amber-300 fill-amber-300/20" />
              ) : (
                <Sun className="w-3.5 h-3.5 text-amber-500" />
              )}
            </button>
          </Tooltip>
        )}

        {/* User Profile & Navigation Menu */}
        {user ? (
          <div className="relative">
            <Tooltip content={`用户个人中心: ${user.name || user.email}`} side="bottom">
              <button
                id="topbar-user-menu-btn"
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-2 p-1 sm:px-2.5 sm:py-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer text-xs focus:outline-none border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
              >
                {/* User Avatar */}
                <div className="w-7 h-7 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center font-bold text-xs shadow-xs overflow-hidden">
                  {user.avatar && (user.avatar.startsWith('http') || user.avatar.startsWith('data:')) ? (
                    <img src={user.avatar} alt="avatar" className="w-full h-full object-cover" />
                  ) : user.avatar ? (
                    <span className="text-sm">{user.avatar}</span>
                  ) : (
                    <span>{user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}</span>
                  )}
                </div>

                <span className="hidden xl:inline text-slate-700 dark:text-slate-200 font-semibold max-w-[90px] truncate">
                  {user.name || user.email.split('@')[0]}
                </span>

                <span
                  className={`hidden sm:inline px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider ${
                    user.role === 'admin'
                      ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                      : isVip
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                  }`}
                >
                  {user.role === 'admin' ? '管理员' : isVip ? 'VIP' : '普通版'}
                </span>
                <ChevronDown className="w-3 h-3 text-slate-400" />
              </button>
            </Tooltip>

            {/* Comprehensive User Profile Menu */}
            {showUserMenu && (
              <div
                id="topbar-user-dropdown-menu"
                className="absolute top-full right-0 mt-2 w-60 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] p-2 z-50 animate-in fade-in zoom-in-95"
              >
                {/* Header Card */}
                <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-xl border border-slate-100 dark:border-slate-800/80 mb-1.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center font-bold text-sm shadow-sm overflow-hidden shrink-0">
                      {user.avatar && (user.avatar.startsWith('http') || user.avatar.startsWith('data:')) ? (
                        <img src={user.avatar} alt="avatar" className="w-full h-full object-cover" />
                      ) : user.avatar ? (
                        <span className="text-base">{user.avatar}</span>
                      ) : (
                        <span>{user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                        {user.name || '深度探索者'}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate">{user.email}</div>
                    </div>
                  </div>

                  <div className="mt-2.5 pt-2 border-t border-slate-200/60 dark:border-slate-800/80 flex items-center justify-between text-[10px]">
                    <span className="text-slate-500">账户权限：</span>
                    {user.role === 'admin' ? (
                      <span className="font-semibold text-purple-600 dark:text-purple-400 flex items-center gap-1">
                        系统管理员
                      </span>
                    ) : isVip ? (
                      <span className="font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <Crown className="w-3 h-3 fill-amber-400/30" /> VIP 尊享会员
                      </span>
                    ) : (
                      <span className="font-medium text-slate-500 dark:text-slate-400">基础免费版</span>
                    )}
                  </div>
                </div>

                <div className="py-1 space-y-0.5">
                  {/* User Profile Action */}
                  <button
                    id="user-menu-profile-btn"
                    onClick={() => {
                      setShowUserMenu(false);
                      openUserProfileModal();
                    }}
                    className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                  >
                    <User className="w-4 h-4 text-indigo-500 shrink-0" />
                    <div>
                      <div className="font-medium">个人中心</div>
                      <div className="text-[10px] text-slate-400">修改头像、昵称与账户信息</div>
                    </div>
                  </button>

                  {/* VIP Membership Action */}
                  <button
                    id="user-menu-vip-btn"
                    onClick={() => {
                      setShowUserMenu(false);
                      openRechargeModal();
                    }}
                    className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                  >
                    <Crown className="w-4 h-4 text-amber-500 shrink-0" />
                    <div>
                      <div className="font-medium">{isVip ? 'VIP 会员权益' : '开通 VIP 会员'}</div>
                      <div className="text-[10px] text-slate-400">
                        {isVip ? '查看特权与续费周期' : '尊享无限画板与深度推演'}
                      </div>
                    </div>
                  </button>

                  {/* Submit Feedback Action (Replacing old Product Intro) */}
                  <button
                    id="user-menu-feedback-btn"
                    onClick={() => {
                      setShowUserMenu(false);
                      openFeedbackModal();
                    }}
                    className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                  >
                    <MessageSquarePlus className="w-4 h-4 text-emerald-500 shrink-0" />
                    <div>
                      <div className="font-medium">提交反馈</div>
                      <div className="text-[10px] text-slate-400">提出功能建议或问题报错</div>
                    </div>
                  </button>

                  {/* Admin Ops (if admin) */}
                  {user.role === 'admin' && (
                    <button
                      id="user-menu-admin-btn"
                      onClick={() => {
                        setShowUserMenu(false);
                        openAdminModal();
                      }}
                      className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/40 rounded-xl transition-colors cursor-pointer"
                    >
                      <ShieldAlert className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                      <div>
                        <div className="font-medium">运营管理台</div>
                        <div className="text-[10px] text-purple-500/70">模型配置与用户权限</div>
                      </div>
                    </button>
                  )}

                  <div className="border-t border-slate-100 dark:border-slate-800 my-1" />

                  {/* Logout */}
                  <button
                    id="user-menu-logout-btn"
                    onClick={() => {
                      setShowUserMenu(false);
                      logout();
                    }}
                    className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl transition-colors cursor-pointer font-medium"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>安全退出登录</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {onGoToLanding && (
              <button
                onClick={onGoToLanding}
                className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <span>介绍</span>
              </button>
            )}
            <button
              onClick={() => openAuthModal('signin')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-xs font-medium shadow-xs transition-colors cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>登录 / 注册</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
