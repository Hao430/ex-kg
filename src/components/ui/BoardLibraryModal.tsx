/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec L1 / ADR-0015：画板库弹窗（搜索 + 收藏 + 归档 + 单层分组）。
 * - 画板列表真相来自父级 boards（board-store），分组来自父级 folders（folder-store），
 *   本组件只做视图筛选/排序，不发列表请求。
 * - 收藏/归档/改名/移动分组经父级回调：画板偏好走 meta 队列（可离线），分组 CRUD 在线优先。
 * - 归档默认隐藏，切「包含归档」查看/恢复。共享默认板（服务端 `isShared`）不可收藏/归档/分组；
 *   公开 id 画板（`SHARED_BOARD_IDS`）不可删除——前者是授权、随 ADR-0018 的模式开关切换，
 *   后者是禁删、与模式无关，两者刻意不共用一个判据。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Search,
  Star,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  Plus,
  LayoutGrid,
  Clock,
  FolderPlus,
  Inbox,
  Folder as FolderIcon,
} from 'lucide-react';
import { Modal } from './base/Modal';
import { StatusBanner } from './base/StatusBanner';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import type { DeepDiveBoardMeta } from '../../types';
import type { FolderMeta } from '../../lib/folder-store';
import { SHARED_BOARD_IDS } from '../../lib/board-scope';
import { formatDate } from '../../lib/format';

type FolderSel = 'all' | 'none' | string;
type SortKey = 'recent' | 'name';
type OpResult = { ok: boolean; error?: string };

export interface BoardLibraryModalProps {
  /** 可选受控显隐，默认 true（兼容现有条件渲染与受控渲染） */
  isOpen?: boolean;
  boards: DeepDiveBoardMeta[];
  folders: FolderMeta[];
  foldersOffline?: boolean;
  currentBoardId: string;
  onClose: () => void;
  onSwitchBoard: (id: string) => void;
  onNewBoard: () => void;
  onDeleteBoard: (id: string) => void;
  onRenameBoard: (id: string, name: string) => void;
  onToggleFavorite: (id: string, value: boolean) => void;
  onToggleArchive: (id: string, value: boolean) => void;
  onMoveBoard: (boardId: string, folderId: string | null) => void;
  onCreateFolder: (name: string) => Promise<OpResult>;
  onRenameFolder: (id: string, name: string) => Promise<OpResult>;
  onDeleteFolder: (id: string) => Promise<OpResult>;
  /** Spec R1：练习 tab 需要知道当前用户（scope 隔离与草稿归属）；游客不显示该 tab */
  userId?: string | null;
  /** Spec R1：是否展示「练习」tab（后端 QUIZ_ENABLED 关闭时端点 404，故前端也不应露出入口） */
  quizEnabled?: boolean;
}

function formatUpdatedAt(ts: number): string {
  return ts ? formatDate(ts) : '';
}

export const BoardLibraryModal: React.FC<BoardLibraryModalProps> = ({
  isOpen = true,
  boards,
  folders,
  foldersOffline = false,
  currentBoardId,
  onClose,
  onSwitchBoard,
  onNewBoard,
  onDeleteBoard,
  onRenameBoard,
  onToggleFavorite,
  onToggleArchive,
  onMoveBoard,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  userId = null,
  quizEnabled = false,
}) => {
  const [query, setQuery] = useState('');
  const [folderSel, setFolderSel] = useState<FolderSel>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [showArchived, setShowArchived] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const { confirm: confirmAction, element: confirmElement } = useConfirmDialog();

  // 分组被删除后选中项失效 → 回落到「全部」
  useEffect(() => {
    if (folderSel !== 'all' && folderSel !== 'none' && !folders.some((f) => f.id === folderSel)) {
      setFolderSel('all');
    }
  }, [folders, folderSel]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = boards.filter((b) => {
      if (b.isArchived && !showArchived) return false;
      if (folderSel === 'none' && (b.folderId ?? null) !== null) return false;
      if (folderSel !== 'all' && folderSel !== 'none' && (b.folderId ?? null) !== folderSel) return false;
      if (favOnly && b.isFavorite !== true) return false;
      return !q || b.name.toLowerCase().includes(q);
    });
    base.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, 'zh') : b.updatedAt - a.updatedAt
    );
    const archivedFirst = [...base].sort((a, b) => Number(Boolean(a.isArchived)) - Number(Boolean(b.isArchived)));
    return [...archivedFirst.filter((b) => b.isFavorite), ...archivedFirst.filter((b) => !b.isFavorite)];
  }, [boards, query, folderSel, sort, showArchived, favOnly]);

  const activeBoards = useMemo(() => boards.filter((b) => !b.isArchived), [boards]);
  const ungroupedCount = activeBoards.filter((b) => (b.folderId ?? null) === null).length;
  const folderCount = (id: string) => activeBoards.filter((b) => b.folderId === id).length;

  const handleRenameBoard = (b: DeepDiveBoardMeta) => {
    const next = window.prompt('重命名画板', b.name);
    if (next == null) return;
    const name = next.trim().slice(0, 255);
    if (!name || name === b.name) return;
    onRenameBoard(b.id, name);
  };

  const handleCreateFolder = async () => {
    const next = window.prompt('新建分组名称');
    if (next == null) return;
    const name = next.trim().slice(0, 64);
    if (!name) return;
    const r = await onCreateFolder(name);
    setStatusMsg(r.ok ? null : r.error || '新建分组失败');
  };

  const handleRenameFolder = async (f: FolderMeta) => {
    const next = window.prompt('重命名分组', f.name);
    if (next == null) return;
    const name = next.trim().slice(0, 64);
    if (!name || name === f.name) return;
    const r = await onRenameFolder(f.id, name);
    setStatusMsg(r.ok ? null : r.error || '重命名失败');
  };

  const handleDeleteFolder = async (f: FolderMeta) => {
    if (
      !(await confirmAction({
        title: `确定删除分组「${f.name}」吗？`,
        description: '组内画板不会被删除，只会回到未分组。',
        confirmLabel: '删除分组',
        tone: 'danger',
      }))
    )
      return;
    const r = await onDeleteFolder(f.id);
    setStatusMsg(r.ok ? null : r.error || '删除分组失败');
  };

  const sidebarBtn = (selected: boolean) =>
    `w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
      selected
        ? 'bg-indigo-600/20 text-indigo-300 font-semibold'
        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
    }`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="2xl"
      showCloseButton={false}
      className="relative w-full max-w-3xl max-h-[82vh] flex flex-col bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl text-slate-100 p-0 overflow-hidden"
    >
      <div id="board-library-container" className="flex flex-col w-full h-full min-h-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/80 shrink-0">
          <div className="flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold tracking-wide">画板库</span>
            <span className="text-xxs text-slate-500 px-1.5 py-0.5 rounded bg-slate-800/80">
              {boards.length} 个画板 · {folders.length} 个分组
            </span>
            {foldersOffline && <span className="text-xxs text-amber-400">离线</span>}
          </div>
          <button
            id="board-library-close-btn"
            onClick={onClose}
            aria-label="关闭"
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Folder sidebar */}
          <aside className="w-40 shrink-0 border-r border-slate-800/60 p-2 space-y-0.5 overflow-y-auto">
            <button id="board-library-folder-all" onClick={() => setFolderSel('all')} className={sidebarBtn(folderSel === 'all')}>
              <LayoutGrid className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate flex-1 text-left">全部画板</span>
              <span className="text-xxs text-slate-500">{activeBoards.length}</span>
            </button>
            <button id="board-library-folder-none" onClick={() => setFolderSel('none')} className={sidebarBtn(folderSel === 'none')}>
              <Inbox className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate flex-1 text-left">未分组</span>
              <span className="text-xxs text-slate-500">{ungroupedCount}</span>
            </button>
            {folders.map((f) => (
              <div key={f.id} className={`group flex items-center rounded-lg ${folderSel === f.id ? 'bg-indigo-600/20' : 'hover:bg-slate-800/60'}`}>
                <button
                  id={`board-library-folder-${f.id}`}
                  onClick={() => setFolderSel(f.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 flex-1 min-w-0 text-xs ${
                    folderSel === f.id ? 'text-indigo-300 font-semibold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FolderIcon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate flex-1 text-left">{f.name}</span>
                  <span className="text-xxs text-slate-500">{folderCount(f.id)}</span>
                </button>
                <button
                  id={`board-library-folder-rename-${f.id}`}
                  onClick={() => void handleRenameFolder(f)}
                  aria-label={`重命名分组 ${f.name}`}
                  className="p-1 text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  id={`board-library-folder-delete-${f.id}`}
                  onClick={() => void handleDeleteFolder(f)}
                  aria-label={`删除分组 ${f.name}`}
                  className="p-1 mr-1 text-slate-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              id="board-library-folder-create"
              onClick={() => void handleCreateFolder()}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-indigo-400 hover:bg-indigo-950/40 transition-colors"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              新建分组
            </button>
          </aside>

          {/* Main */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-4 py-3 border-b border-slate-800/60 space-y-2.5 shrink-0">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="board-library-search"
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索画板名…"
                    autoFocus
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl bg-slate-950/60 border border-slate-800 text-slate-100 placeholder:text-slate-600 outline-none focus:border-indigo-600/70"
                  />
                </div>
                <button
                  id="board-library-sort-btn"
                  onClick={() => setSort((s) => (s === 'recent' ? 'name' : 'recent'))}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium bg-slate-800/70 text-slate-300 hover:bg-slate-700 transition-colors shrink-0"
                >
                  {sort === 'recent' ? <Clock className="w-3.5 h-3.5" /> : <span className="text-sm leading-none">A↕</span>}
                  {sort === 'recent' ? '最近' : '名称'}
                </button>
                <button
                  id="board-library-new-btn"
                  onClick={onNewBoard}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  新建
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  id="board-library-filter-fav"
                  onClick={() => setFavOnly((v) => !v)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    favOnly ? 'bg-amber-500/20 text-amber-300 border border-amber-700/60' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                  }`}
                >
                  <Star className="w-3 h-3" fill={favOnly ? 'currentColor' : 'none'} />
                  仅收藏
                </button>
                <button
                  id="board-library-filter-archived"
                  onClick={() => setShowArchived((v) => !v)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    showArchived ? 'bg-slate-700/60 text-slate-200 border border-slate-600/60' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                  }`}
                >
                  <Archive className="w-3 h-3" />
                  包含归档
                </button>
              </div>
              {statusMsg && (
                <StatusBanner
                  type="error"
                  unstyled
                  icon={null}
                  className="px-3 py-1.5 rounded-lg text-xxs bg-rose-950/40 border border-rose-800/60 text-rose-300"
                >
                  {statusMsg}
                </StatusBanner>
              )}
            </div>

            {/* Board list */}
            <div className="flex-1 overflow-y-auto p-3">
              {list.length === 0 ? (
                <div className="py-14 flex flex-col items-center gap-3 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-slate-800/80 flex items-center justify-center">
                    <LayoutGrid className="w-5 h-5 text-slate-500" />
                  </div>
                  <p className="text-sm text-slate-300 font-medium">
                    {query.trim() ? '没有匹配的画板' : favOnly ? '还没有收藏画板' : '这里还没有画板'}
                  </p>
                  {!query.trim() && folderSel === 'all' && !favOnly && (
                    <button
                      onClick={onNewBoard}
                      className="text-xs font-semibold px-4 py-1.5 rounded-xl bg-slate-800 text-slate-200 hover:bg-slate-700 transition"
                    >
                      新建思考画板
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  {list.map((b) => {
                    // 「共享」是**服务端口径**（ADR-0018）：legacy 模式下旧的全局共享默认板为 true，
                    // private 模式下它就是认领者自己的普通画板（收藏/归档/分组照常）。客户端不再按
                    // 公开 id 集合自行判断——模式是服务端 env，判断不了。
                    const shared = b.isShared === true;
                    // 「禁删」与授权解耦（ADR-0012/0018）：公开 id 两种模式下都禁删，故不给入口
                    const undeletable = SHARED_BOARD_IDS.has(b.id);
                    const active = b.id === currentBoardId;
                    return (
                      <div
                        key={b.id}
                        id={`board-library-item-${b.id}`}
                        onClick={() => {
                          onSwitchBoard(b.id);
                          onClose();
                        }}
                        className={`group flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer border transition-colors ${
                          active ? 'bg-indigo-950/40 border-indigo-800/60' : 'border-transparent hover:bg-slate-800/50 hover:border-slate-800'
                        }`}
                      >
                        <button
                          id={`board-library-fav-${b.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!shared) onToggleFavorite(b.id, !b.isFavorite);
                          }}
                          disabled={shared}
                          aria-label={b.isFavorite ? '取消收藏' : '收藏'}
                          className={`p-1 rounded-lg transition-colors shrink-0 ${shared ? 'opacity-30 cursor-not-allowed' : 'hover:bg-slate-700/60'}`}
                        >
                          <Star
                            className={`w-4 h-4 ${b.isFavorite ? 'text-amber-400' : 'text-slate-600 group-hover:text-slate-400'}`}
                            fill={b.isFavorite ? 'currentColor' : 'none'}
                          />
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-sm truncate ${active ? 'text-indigo-200 font-semibold' : 'text-slate-200'}`}>
                              {b.name}
                            </span>
                            {b.isArchived && (
                              <span className="text-xxs px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">已归档</span>
                            )}
                            {shared && (
                              <span className="text-xxs px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 shrink-0">共享</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-xxs text-slate-500">
                            <span>{b.nodeCount || 0} 个节点</span>
                            {formatUpdatedAt(b.updatedAt) && (
                              <>
                                <span>·</span>
                                <span>{formatUpdatedAt(b.updatedAt)} 更新</span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Move to folder */}
                        {!shared && (
                          <select
                            id={`board-library-move-${b.id}`}
                            value={b.folderId ?? ''}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation();
                              onMoveBoard(b.id, e.target.value || null);
                            }}
                            aria-label="移动到分组"
                            className="shrink-0 max-w-[92px] text-xxs bg-slate-800/70 border border-slate-700/60 rounded-lg px-1.5 py-1 text-slate-300 outline-none focus:border-indigo-600/70"
                          >
                            <option value="">未分组</option>
                            {folders.map((f) => (
                              <option key={f.id} value={f.id}>{f.name}</option>
                            ))}
                          </select>
                        )}

                        <div
                          className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            id={`board-library-rename-${b.id}`}
                            onClick={() => handleRenameBoard(b)}
                            aria-label={`重命名画板 ${b.name}`}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {!shared && (
                            <button
                              id={`board-library-archive-${b.id}`}
                              onClick={() => onToggleArchive(b.id, !b.isArchived)}
                              aria-label={b.isArchived ? '恢复画板' : '归档画板'}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
                            >
                              {b.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                            </button>
                          )}
                          {!undeletable && (
                            <button
                              id={`board-library-delete-${b.id}`}
                              onClick={() => onDeleteBoard(b.id)}
                              aria-label={`删除画板 ${b.name}`}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Promise 化确认框（删除分组等） */}
      {confirmElement}
    </Modal>
  );
};
