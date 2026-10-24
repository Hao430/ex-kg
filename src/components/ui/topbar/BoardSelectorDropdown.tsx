/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  FolderOpen,
  ChevronDown,
  Pencil,
  CloudOff,
  Star,
  Check,
  Trash2,
  Sparkles,
  LayoutGrid,
  Plus,
} from 'lucide-react';
import { DeepDiveBoardMeta } from '../../../types';
import type { FolderMeta } from '../../../lib/folder-store';
import { buildQuickSections } from '../../../lib/board-sections';
import { SHARED_BOARD_IDS } from '../../../lib/board-scope';
import { useQuotaView } from '../../../hooks/useBoards';
import { useClickOutside } from '../../../hooks/useClickOutside';
import { Tooltip } from '../Tooltip';

export interface BoardSelectorDropdownProps {
  boardName: string;
  boards: DeepDiveBoardMeta[];
  currentBoardId?: string;
  activeBoardId?: string;
  folders?: FolderMeta[];
  onRenameBoard: (newName: string) => void;
  onSwitchBoard?: (boardId: string) => void;
  onSelectBoard?: (boardId: string) => void;
  onDeleteBoard: (boardId: string) => void;
  onNewBoard: () => void;
  onOpenSamples?: () => void;
  onOpenLibrary?: () => void;
}

export const BoardSelectorDropdown: React.FC<BoardSelectorDropdownProps> = ({
  boardName,
  boards,
  currentBoardId,
  activeBoardId,
  folders = [],
  onRenameBoard,
  onSwitchBoard,
  onSelectBoard,
  onDeleteBoard,
  onNewBoard,
  onOpenSamples,
  onOpenLibrary,
}) => {
  const targetBoardId = currentBoardId ?? activeBoardId ?? '';
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(boardName);
  const [showBoardMenu, setShowBoardMenu] = useState(false);
  const quota = useQuotaView();
  const boardMenuRef = useRef<HTMLDivElement>(null);

  const handleSelect = (id: string) => {
    onSwitchBoard?.(id);
    onSelectBoard?.(id);
    setShowBoardMenu(false);
  };

  const handleNameSubmit = () => {
    setIsEditingName(false);
    if (nameInput.trim()) {
      onRenameBoard(nameInput.trim());
    } else {
      setNameInput(boardName);
    }
  };

  // 点击外部与 Escape 监听
  useClickOutside({
    refs: [boardMenuRef],
    enabled: showBoardMenu,
    onOutside: () => setShowBoardMenu(false),
    closeOnEscape: true,
  });

  return (
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
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors cursor-pointer"
            >
              <Pencil className="w-2.5 h-2.5" />
            </button>
          </Tooltip>
        </div>
      )}

      {/* 画板用量指示 */}
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

      {/* 画板列表下拉菜单 */}
      {showBoardMenu && (
        <div className="absolute top-full left-0 mt-2 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] py-2 z-50 animate-in fade-in zoom-in-95">
          <div className="px-3 py-1 flex items-center justify-between text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
            <span>思考画板列表</span>
            <span className="normal-case tracking-normal">
              {quota.unlimited ? '不限' : `${quota.used}/${quota.limit ?? 3}`}
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto mt-1">
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
                    onClick={() => handleSelect(b.id)}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors cursor-pointer ${
                      b.id === targetBoardId
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
                      {b.id === targetBoardId && (
                        <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                      )}
                      {!SHARED_BOARD_IDS.has(b.id) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteBoard(b.id);
                            setShowBoardMenu(false);
                          }}
                          aria-label={`删除画板 ${b.name}`}
                          className="p-1 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
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
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-xl transition-colors cursor-pointer"
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
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-xl transition-colors cursor-pointer"
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
              className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-indigo-600 dark:text-indigo-400 font-medium hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-xl transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              新建思考画板
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
