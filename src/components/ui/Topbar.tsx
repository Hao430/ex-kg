/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Sparkles,
  FolderOpen,
  Plus,
  Maximize2,
  LayoutGrid,
  Download,
  FileText,
  FileJson,
  FileUp,
  ImageDown,
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
  Link2,
  Share2,
  Star,
  Archive,
  Search,
  X,
  Loader2,
} from 'lucide-react';
import { DeepDiveBoardMeta } from '../../types';
import type { FolderMeta } from '../../lib/folder-store';
import { buildQuickSections } from '../../lib/board-sections';
import { SHARED_BOARD_IDS } from '../../lib/board-scope';
import { useAuth } from '../../context/AuthContext';
import { useQuotaView } from '../../hooks/useBoards';
import { Tooltip } from './Tooltip';

/**
 * GET /api/canvases/:id/search 的结果项（仓储 searchNodes 双模统一的 camelCase 形状）。
 * 只读展示，不回写画板。
 */
interface NodeSearchResult {
  id: string;
  canvasId: string;
  title: string;
  question: string;
  answer: string;
  noteContent: string;
  depth: number;
  model: string;
  type: string;
}

interface TopbarProps {
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
   * 关闭是**有副作用**的：会清理本板占位且之后不再生成（确认框在画布侧），
   * 不再是原先的「仅隐藏视图」。
   */
  suggestionsEnabled?: boolean;
  /**
   * 共享默认画板（legacy）不支持画板级设置——服务端 `updateCanvasMeta` 对它直接 403，
   * 故开关前置禁用（而不是让用户点完再吃一个错误）。
   */
  suggestionsToggleDisabled?: boolean;
  onToggleSuggestions?: () => void;
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
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(boardName);
  const [showBoardMenu, setShowBoardMenu] = useState(false);
  const quota = useQuotaView();
  const [showCanvasMoreMenu, setShowCanvasMoreMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  // 节点搜索浮层（画板内检索）：防抖 + AbortController，空 q 不发请求
  const [showSearchMenu, setShowSearchMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NodeSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  const searchMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<number | null>(null);

  /** 关闭搜索浮层：同时取消未完成的防抖/在途请求，避免关闭后 setState（卸载后警告） */
  const closeSearchMenu = useCallback(() => {
    setShowSearchMenu(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchActiveIdx(0);
    setSearchLoading(false);
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
  }, []);

  const runNodeSearch = useCallback(
    async (q: string, boardId: string) => {
      searchAbortRef.current?.abort();
      const ctrl = new AbortController();
      searchAbortRef.current = ctrl;
      try {
        const res = await fetch(
          `/api/canvases/${encodeURIComponent(boardId)}/search?q=${encodeURIComponent(q)}`,
          { credentials: 'include', signal: ctrl.signal }
        );
        if (!res.ok) throw new Error(`search ${res.status}`);
        const body = await res.json().catch(() => null);
        if (ctrl.signal.aborted) return;
        setSearchResults(Array.isArray(body?.results) ? body.results : []);
        setSearchActiveIdx(0);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        if (ctrl.signal.aborted) return;
        setSearchResults([]);
        setSearchActiveIdx(0);
      } finally {
        if (searchAbortRef.current === ctrl) {
          searchAbortRef.current = null;
          setSearchLoading(false);
        }
      }
    },
    []
  );

  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimerRef.current !== null) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        // 空 q 语义 = 空结果：不发请求（与后端「空 q 早退」口径一致）
        searchAbortRef.current?.abort();
        searchAbortRef.current = null;
        setSearchResults([]);
        setSearchActiveIdx(0);
        setSearchLoading(false);
        return;
      }
      setSearchLoading(true);
      searchTimerRef.current = window.setTimeout(() => void runNodeSearch(trimmed, currentBoardId), 300);
    },
    [currentBoardId, runNodeSearch]
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSearchActiveIdx((i) => {
          if (!searchResults.length) return 0;
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          return (i + dir + searchResults.length) % searchResults.length;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = searchResults[searchActiveIdx];
        if (hit) {
          closeSearchMenu();
          onSearchResultClick?.(hit.id);
        }
      }
    },
    [searchResults, searchActiveIdx, closeSearchMenu, onSearchResultClick]
  );

  // 键盘上下选时让 active 项保持可见（列表最多 30 条，max-h-72 约可见 7 条）
  useEffect(() => {
    if (!showSearchMenu) return;
    searchResultsRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [searchActiveIdx, showSearchMenu]);

  const handlePickSearchResult = useCallback(
    (nodeId: string) => {
      closeSearchMenu();
      onSearchResultClick?.(nodeId);
    },
    [closeSearchMenu, onSearchResultClick]
  );

  const boardMenuRef = useRef<HTMLDivElement>(null);
  const canvasMoreMenuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // 点击空白地方自动收起：画布列表卡片、更多操作卡片、个人中心卡片、节点搜索浮层
  useEffect(() => {
    if (!showBoardMenu && !showCanvasMoreMenu && !showUserMenu && !showSearchMenu) return;

    const handleClickOutside = (event: MouseEvent | PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (showBoardMenu && boardMenuRef.current && !boardMenuRef.current.contains(target)) {
        setShowBoardMenu(false);
      }
      if (showCanvasMoreMenu && canvasMoreMenuRef.current && !canvasMoreMenuRef.current.contains(target)) {
        setShowCanvasMoreMenu(false);
      }
      if (showUserMenu && userMenuRef.current && !userMenuRef.current.contains(target)) {
        setShowUserMenu(false);
      }
      if (showSearchMenu && searchMenuRef.current && !searchMenuRef.current.contains(target)) {
        closeSearchMenu();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowBoardMenu(false);
        setShowCanvasMoreMenu(false);
        setShowUserMenu(false);
        closeSearchMenu();
      }
    };

    document.addEventListener('pointerdown', handleClickOutside, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showBoardMenu, showCanvasMoreMenu, showUserMenu, showSearchMenu, closeSearchMenu]);

  const {
    user,
    isVip,
    openAuthModal,
    openRechargeModal,
    openUserProfileModal,
    openMySharesModal,
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

        {/* Sync Status Indicator (Spec A5)：云图标态 —— 斜杠云=本地模式，灰云=待同步，绿云=已同步，红云=失败/冲突/离线 */}
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
            className={`flex items-center justify-center w-7 h-7 rounded-lg cursor-default ${
              !user
                ? 'text-slate-400 dark:text-slate-500'
                : offline || syncState === 'error' || syncState === 'conflict'
                ? 'text-red-500'
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

        {/* Board Switcher & Quick Rename */}
        <div ref={boardMenuRef} className="relative flex items-center">
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

          {/* 画板用量：服务端 /api/quota 权威 + 本地待建（离线显示最近快照） */}
          <Tooltip
            content={
              quota.offline
                ? '离线中，显示最近一次用量'
                : quota.unlimited
                  ? '当前账号不限画板数'
                  : '已用画板数 / 免费版上限'
            }
            side="bottom"
          >
            <span className="ml-1 hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-xl text-[11px] font-semibold bg-slate-100/70 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border border-slate-200/50 dark:border-slate-700/50">
              {quota.offline && <CloudOff className="w-3 h-3 text-amber-500" />}
              画板 {quota.used}/{quota.unlimited ? '∞' : quota.limit ?? 3}
            </span>
          </Tooltip>

          {/* Board Dropdown Menu */}
          {showBoardMenu && (
            <div className="absolute top-full left-0 mt-2 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] py-2 z-50 animate-in fade-in zoom-in-95">
              <div className="px-3 py-1 flex items-center justify-between text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                <span>思考画板列表</span>
                <span className="normal-case tracking-normal">
                  {quota.unlimited ? '不限' : `${quota.used}/${quota.limit ?? 3}`}
                </span>
              </div>
              <div className="max-h-52 overflow-y-auto mt-1">
                {/* Spec L1：归档不进快捷切换；收藏置顶，其余按分组渲染小标题 */}
                {buildQuickSections(boards, folders).map((sec) => (
                  <div key={sec.key}>
                    {sec.label && (
                      <div className="px-3 pt-2 pb-0.5 flex items-center gap-1 text-[10px] font-semibold text-slate-400 dark:text-slate-600 uppercase tracking-wider">
                        {sec.key === '__fav' ? (
                          <Star className="w-3 h-3 text-amber-400" fill="currentColor" />
                        ) : sec.key === '__none' ? null : (
                          <FolderOpen className="w-3 h-3" />
                        )}
                        <span className="truncate">{sec.label}</span>
                      </div>
                    )}
                    {sec.boards.map((b) => (
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
                        <span className="flex items-center gap-1 min-w-0 flex-1 mr-2">
                          {b.isFavorite && sec.key !== '__fav' && (
                            <Star className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" />
                          )}
                          <span className="truncate">{b.name}</span>
                        </span>
                        <span className="flex items-center gap-0.5 shrink-0">
                          {b.id === currentBoardId && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                          {/* 旧共享默认板两种模式下都禁删（ADR-0012/0018）：不给入口，免得点了只收到 403 */}
                          {!SHARED_BOARD_IDS.has(b.id) && (
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
                ))}
              </div>
              <div className="border-t border-slate-100 dark:border-slate-800 mt-1.5 pt-1.5 px-2 space-y-0.5">
                {onOpenSamples && (
                  <button
                    onClick={() => {
                      onOpenSamples();
                      setShowBoardMenu(false);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-xl transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    示例画布 · 看看怎么用
                  </button>
                )}
                {onOpenLibrary && (
                  <button
                    onClick={() => {
                      onOpenLibrary();
                      setShowBoardMenu(false);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-xl transition-colors"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    画板库 · 搜索 / 收藏 / 归档
                  </button>
                )}
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

        {/* Spec L1：画板库入口（搜索 / 收藏 / 归档） */}
        {onOpenLibrary && (
          <Tooltip content="画板库（搜索 / 收藏 / 归档）" side="bottom">
            <button
              onClick={onOpenLibrary}
              className="flex items-center gap-1 px-2 py-1.5 rounded-xl bg-slate-100/70 dark:bg-slate-800/60 hover:bg-slate-200/70 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200 text-xs font-medium border border-slate-200/50 dark:border-slate-700/50 transition-colors"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span className="hidden md:inline">画板库</span>
            </button>
          </Tooltip>
        )}

        {/* Spec Q1：灵感开关是画板级的「保留/不保留」，关闭会清理本板占位（不可恢复）——
            不再是视图隐藏，故文案必须说清代价 */}
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
            <div className="hidden sm:flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-xl bg-slate-100/70 dark:bg-slate-800/60 border border-slate-200/50 dark:border-slate-700/50">
              <Sparkles className="w-3 h-3 text-indigo-500 dark:text-indigo-400 shrink-0" />
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 hidden lg:inline">
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

        {/* Node Search: 画板内节点检索（GET /api/canvases/:id/search，严格属主制） */}
        <div ref={searchMenuRef} className="relative">
          <Tooltip content="搜索当前画板内的节点" side="bottom">
            <button
              id="topbar-node-search-btn"
              onClick={() => {
                if (showSearchMenu) {
                  closeSearchMenu();
                  return;
                }
                setShowSearchMenu(true);
                setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
              className="p-1.5 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition-colors cursor-pointer flex items-center"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          {showSearchMenu && (
            <div className="absolute top-full right-0 mt-2 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] z-50 animate-in fade-in zoom-in-95 overflow-hidden">
              <div className="relative p-2 border-b border-slate-100 dark:border-slate-800">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchInput(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="搜索节点内容…"
                  maxLength={100}
                  className="w-full pl-8 pr-8 py-1.5 text-xs bg-slate-100/70 dark:bg-slate-800/60 border border-slate-200/50 dark:border-slate-700/50 rounded-xl outline-none focus:border-indigo-400 dark:focus:border-indigo-500/60 text-slate-850 dark:text-slate-100 placeholder:text-slate-400 transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      handleSearchInput('');
                      searchInputRef.current?.focus();
                    }}
                    aria-label="清空搜索"
                    className="absolute right-5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                  >
                    {searchLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>

              <div ref={searchResultsRef} className="max-h-72 overflow-y-auto p-1.5">
                {!searchQuery.trim() ? (
                  <div className="px-3 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                    输入关键词，检索本画板的思考节点与便签
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                    {searchLoading ? '正在搜索…' : '未找到匹配的节点'}
                  </div>
                ) : (
                  searchResults.map((r, idx) => {
                    const isNote = r.type === 'note';
                    const excerpt = (isNote ? r.noteContent : r.answer || r.question) || '';
                    return (
                      <button
                        key={r.id}
                        data-active={idx === searchActiveIdx}
                        onMouseEnter={() => setSearchActiveIdx(idx)}
                        onClick={() => handlePickSearchResult(r.id)}
                        className={`w-full text-left px-2.5 py-2 rounded-xl transition-colors cursor-pointer ${
                          idx === searchActiveIdx
                            ? 'bg-indigo-50 dark:bg-indigo-950/40'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-bold ${
                              isNote
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                : 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                            }`}
                          >
                            {isNote ? '便签' : '主题'}
                          </span>
                          <span className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate">
                            {r.title || '（无标题）'}
                          </span>
                        </div>
                        {excerpt && (
                          <div className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400 line-clamp-2">
                            {excerpt}
                          </div>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

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
                  onShareLink?.();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
              >
                <Link2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <div className="font-medium">分享链接</div>
                  <div className="text-[10px] text-slate-400">生成只读分享页，访客可一键克隆</div>
                </div>
              </button>

              <button
                onClick={() => {
                  onExportPng();
                  setShowCanvasMoreMenu(false);
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
              >
                <ImageDown className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                <div>
                  <div className="font-medium">导出 PNG 图片</div>
                  <div className="text-[10px] text-slate-400">可分享的思维全景图（含水印）</div>
                </div>
              </button>

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

              <button
                onClick={() => {
                  setShowCanvasMoreMenu(false);
                  importInputRef.current?.click();
                }}
                className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
              >
                <FileUp className="w-4 h-4 text-cyan-600 dark:text-cyan-400 shrink-0" />
                <div>
                  <div className="font-medium">导入 JSON 备份</div>
                  <div className="text-[10px] text-slate-400">从已导出的备份恢复为新画板</div>
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
          <div ref={userMenuRef} className="relative">
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

                  {/* My Shares Action（我的分享管理，2026-09-09） */}
                  <button
                    id="user-menu-my-shares-btn"
                    onClick={() => {
                      setShowUserMenu(false);
                      openMySharesModal();
                    }}
                    className="w-full text-left px-2.5 py-2 text-xs flex items-center gap-2.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                  >
                    <Share2 className="w-4 h-4 text-sky-500 shrink-0" />
                    <div>
                      <div className="font-medium">我的分享</div>
                      <div className="text-[10px] text-slate-400">管理生效中的分享链接</div>
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
