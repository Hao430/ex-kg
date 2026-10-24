/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { useClickOutside } from '../../../hooks/useClickOutside';
import { Spinner } from '../base/Spinner';

/**
 * GET /api/canvases/:id/search 的结果项
 */
export interface NodeSearchResult {
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

export interface NodeSearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 画板 ID（支持 boardId 或 currentBoardId） */
  boardId?: string;
  currentBoardId?: string;
  /** 节点选中回调（支持 onSelectNode 或 onSearchResultClick） */
  onSelectNode?: (nodeId: string) => void;
  onSearchResultClick?: (nodeId: string) => void;
  /** 可选：触发按钮的 ref，避免外部点击与按钮点击冲突 */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export const NodeSearchDialog: React.FC<NodeSearchDialogProps> = ({
  isOpen,
  onClose,
  boardId,
  currentBoardId,
  onSelectNode,
  onSearchResultClick,
  triggerRef,
}) => {
  const activeBoardId = boardId ?? currentBoardId ?? '';
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NodeSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);

  const notifySelect = useCallback(
    (id: string) => {
      onSelectNode?.(id);
      onSearchResultClick?.(id);
    },
    [onSelectNode, onSearchResultClick]
  );

  const handleClose = useCallback(() => {
    onClose();
    setSearchQuery('');
    setSearchResults([]);
    setSearchActiveIdx(0);
    setSearchLoading(false);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, [onClose]);

  // 打开时自动聚焦输入框
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // 点击外部与 Escape 监听
  useClickOutside({
    refs: [containerRef],
    enabled: isOpen,
    onOutside: handleClose,
    ignore: (target) => !!triggerRef?.current?.contains(target),
    closeOnEscape: true,
  });

  // 执行搜索
  const runNodeSearch = useCallback(
    async (q: string, targetId: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(
          `/api/canvases/${encodeURIComponent(targetId)}/search?q=${encodeURIComponent(q)}`,
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
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          setSearchLoading(false);
        }
      }
    },
    []
  );

  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        abortRef.current?.abort();
        abortRef.current = null;
        setSearchResults([]);
        setSearchActiveIdx(0);
        setSearchLoading(false);
        return;
      }
      setSearchLoading(true);
      timerRef.current = window.setTimeout(
        () => void runNodeSearch(trimmed, activeBoardId),
        300
      );
    },
    [activeBoardId, runNodeSearch]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // 输入法组词态：Enter/方向键属于候选词操作，不拦截（防组词确认被误当搜索选中）
      if (e.nativeEvent.isComposing) return;
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
          handleClose();
          notifySelect(hit.id);
        }
      }
    },
    [searchResults, searchActiveIdx, handleClose, notifySelect]
  );

  // 键盘上下选时保持可视
  useEffect(() => {
    if (!isOpen) return;
    resultsRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [searchActiveIdx, isOpen]);

  const handlePickSearchResult = useCallback(
    (nodeId: string) => {
      handleClose();
      notifySelect(nodeId);
    },
    [handleClose, notifySelect]
  );

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      className="absolute top-full right-0 mt-2 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.6)] z-50 animate-in fade-in zoom-in-95 overflow-hidden"
    >
      <div className="relative p-2 border-b border-slate-100 dark:border-slate-800">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearchInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索节点内容…"
          maxLength={100}
          className="w-full pl-8 pr-8 py-1.5 text-xs bg-slate-100/70 dark:bg-slate-800/60 border border-slate-200/50 dark:border-slate-700/50 rounded-xl outline-none focus:border-indigo-400 dark:focus:border-indigo-500/60 text-slate-850 dark:text-slate-100 placeholder:text-slate-400 transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => {
              handleSearchInput('');
              inputRef.current?.focus();
            }}
            aria-label="清空搜索"
            className="absolute right-5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
          >
            {searchLoading ? <Spinner size="sm" /> : <X className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      <div ref={resultsRef} className="max-h-72 overflow-y-auto p-1.5">
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
                    className={`shrink-0 px-1.5 py-0.5 rounded-md text-xxs font-bold ${
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
                  <div className="mt-0.5 text-xxs leading-snug text-slate-500 dark:text-slate-400 line-clamp-2">
                    {excerpt}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
