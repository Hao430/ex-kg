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
  Database,
  Server,
  Cloud,
  Coins,
  ShieldAlert,
  LogIn,
  LogOut,
  User,
  Zap,
} from 'lucide-react';
import { DeepDiveBoardMeta } from '../../types';
import { fetchDbStatus } from '../../lib/storage';
import { useAuth } from '../../context/AuthContext';

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
  const [showDbMenu, setShowDbMenu] = useState(false);
  const [dbStatus, setDbStatus] = useState<{
    connected: boolean;
    type: 'postgresql' | 'in-memory-fallback';
    message: string;
    canvasCount: number;
    nodeCount: number;
    databaseUrlConfigured: boolean;
  } | null>(null);
  const [isLoadingDb, setIsLoadingDb] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const { user, openAuthModal, openRechargeModal, openAdminModal, logout } = useAuth();

  const handleOpenDbMenu = async () => {
    setShowDbMenu((prev) => !prev);
    if (!showDbMenu) {
      setIsLoadingDb(true);
      const status = await fetchDbStatus();
      setDbStatus(status);
      setIsLoadingDb(false);
    }
  };

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

        {/* Database Status Dropdown */}
        <div className="relative">
          <button
            onClick={handleOpenDbMenu}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all ${
              dbStatus?.connected
                ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/50 border border-emerald-300/50 dark:border-emerald-700/50'
                : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
            }`}
            title="查看 PostgreSQL 数据库连接与同步状态"
          >
            <Database className={`w-3.5 h-3.5 ${dbStatus?.connected ? 'text-emerald-500' : 'text-slate-500 dark:text-slate-400'}`} />
            <span className="hidden sm:inline">
              {dbStatus?.connected ? 'PG 已连接' : '数据库'}
            </span>
          </button>

          {showDbMenu && (
            <div className="absolute top-full right-0 mt-1.5 w-72 sm:w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-4 z-50 animate-in fade-in zoom-in-95">
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                    <Database className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    PostgreSQL 存储状态
                  </span>
                </div>
                <button
                  onClick={handleOpenDbMenu}
                  className="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  ✕
                </button>
              </div>

              {isLoadingDb ? (
                <div className="py-6 text-center text-xs text-slate-400 animate-pulse">
                  正在探测数据库连接...
                </div>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60">
                    <div className="mt-0.5">
                      {dbStatus?.connected ? (
                        <span className="flex h-2 w-2 relative">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full h-2 w-2 bg-amber-400"></span>
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">
                        {dbStatus?.connected
                          ? 'PostgreSQL 数据库在线'
                          : '本地存储与内存回退中'}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                        {dbStatus?.message}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800">
                      <div className="text-[10px] text-slate-400">已保存画板</div>
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-100 mt-0.5">
                        {dbStatus?.canvasCount ?? 1}
                      </div>
                    </div>
                    <div className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800">
                      <div className="text-[10px] text-slate-400">思维节点总量</div>
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-100 mt-0.5">
                        {dbStatus?.nodeCount ?? 0}
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <div className="flex items-center gap-1 text-slate-700 dark:text-slate-300 font-medium">
                      <Server className="w-3 h-3 text-blue-500" />
                      <span>后端 RESTful API：已全面接驳</span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">
                      已生成完整数据库设计规范文档与初始化 SQL 脚本（详见根目录 DATABASE_DESIGN.md 与 migrations/）。
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

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

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 mx-0.5" />

        {/* User Account & Credits Section */}
        {user ? (
          <div className="flex items-center gap-2">
            {/* Credits Pill with Top-up Trigger */}
            <button
              onClick={openRechargeModal}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-900/50 text-amber-800 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/80 text-xs font-semibold transition-all cursor-pointer shadow-2xs"
              title="点击充值 AI 算力点数"
            >
              <Coins className="w-3.5 h-3.5 text-amber-500" />
              <span>{user.credits_balance.toLocaleString()}</span>
              <span className="text-[10px] font-normal opacity-75">点</span>
              <div className="w-3.5 h-3.5 rounded-full bg-amber-200/60 dark:bg-amber-800/60 flex items-center justify-center text-amber-700 dark:text-amber-200 ml-0.5">
                <Plus className="w-2.5 h-2.5" />
              </div>
            </button>

            {/* Admin Console Entry Button */}
            {user.role === 'admin' && (
              <button
                onClick={openAdminModal}
                className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-purple-50 hover:bg-purple-100 dark:bg-purple-950/50 dark:hover:bg-purple-900/50 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 text-xs font-medium transition-colors cursor-pointer"
                title="打开运营管理后台"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                <span className="hidden xl:inline">运营后台</span>
              </button>
            )}

            {/* User Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-1.5 p-1 sm:px-2.5 sm:py-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer text-xs"
              >
                <div className="w-6 h-6 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-[11px]">
                  {user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}
                </div>
                <span className="hidden lg:inline text-slate-700 dark:text-slate-200 font-medium max-w-[90px] truncate">
                  {user.name || user.email.split('@')[0]}
                </span>
                <span
                  className={`hidden sm:inline px-1.5 py-0.2 rounded text-[9px] font-bold ${
                    user.role === 'admin'
                      ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                      : user.role === 'vip'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                  }`}
                >
                  {user.role.toUpperCase()}
                </span>
              </button>

              {showUserMenu && (
                <div className="absolute top-full right-0 mt-1.5 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95">
                  <div className="px-2.5 py-2 border-b border-slate-100 dark:border-slate-800">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                      {user.name || '探索者'}
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">{user.email}</div>
                  </div>

                  <div className="py-1">
                    <button
                      onClick={() => {
                        setShowUserMenu(false);
                        openRechargeModal();
                      }}
                      className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg"
                    >
                      <Zap className="w-3.5 h-3.5 text-amber-500" />
                      <span>充值 AI 算力</span>
                    </button>

                    {user.role === 'admin' && (
                      <button
                        onClick={() => {
                          setShowUserMenu(false);
                          openAdminModal();
                        }}
                        className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg"
                      >
                        <ShieldAlert className="w-3.5 h-3.5 text-purple-600" />
                        <span>运营管理控制台</span>
                      </button>
                    )}

                    <button
                      onClick={() => {
                        setShowUserMenu(false);
                        logout();
                      }}
                      className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>安全退出登录</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <button
            onClick={() => openAuthModal('signin')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-xs font-medium shadow-xs transition-colors cursor-pointer"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>登录 / 注册</span>
          </button>
        )}
      </div>
    </header>
  );
};
