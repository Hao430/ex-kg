/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1/R2 — AI 练习工作台侧边栏组件。
 * 负责：
 * 1. 顶部发起新练习主按钮
 * 2. 大盘学情掌握度总览（支持服务端精确统计与本地缓存双模）
 * 3. 往期记录列表（含「全部」与「待复盘」错题筛选、分页加载与单条/全部删除）
 */
import React from 'react';
import {
  BookOpen,
  Eye,
  Loader2,
  Plus,
  Trash2,
  TrendingUp,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import type { QuizDifficulty, QuizHistoryItem, QuizHistoryView } from '../../lib/quiz-store';
import { DIFFICULTY_LABELS } from './constants';

export interface MasteryStats {
  totalAttempted: number;
  totalCorrect: number;
  totalQuestions: number;
  rate: number;
}

export interface PracticeSidebarProps {
  historyView: QuizHistoryView;
  historyFilter: 'all' | 'mistakes';
  onSetHistoryFilter: (filter: 'all' | 'mistakes') => void;
  masteryStats: MasteryStats;
  displayedHistoryItems: QuizHistoryItem[];
  mistakeItemsCount: number;
  currentAttemptId?: string | null;
  onStartNew: () => void;
  onStartNewWithTopic: (topic: string, difficulty?: QuizDifficulty) => void;
  onOpenDetail: (item: QuizHistoryItem) => void;
  onDeleteAttempt: (item: QuizHistoryItem) => void;
  onClearHistory: () => void;
  onLoadMore: () => void;
  isCollapsed?: boolean;
}

export const PracticeSidebar: React.FC<PracticeSidebarProps> = ({
  historyView,
  historyFilter,
  onSetHistoryFilter,
  masteryStats,
  displayedHistoryItems,
  mistakeItemsCount,
  currentAttemptId,
  onStartNew,
  onStartNewWithTopic,
  onOpenDetail,
  onDeleteAttempt,
  onClearHistory,
  onLoadMore,
  isCollapsed = false,
}) => {
  if (isCollapsed) return null;

  return (
    <aside className="w-80 shrink-0 border-r border-slate-200/90 dark:border-slate-800/80 bg-white/80 dark:bg-[#0b101d]/75 backdrop-blur-md flex flex-col min-h-0 transition-all duration-200 select-none">
      {/* 顶部主 CTA 按钮 */}
      <div className="p-3.5 sm:p-4 border-b border-slate-200/60 dark:border-slate-800/60 shrink-0">
        <button
          type="button"
          onClick={onStartNew}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 active:scale-[0.99] text-white font-medium text-xs sm:text-sm shadow-md shadow-indigo-600/20 hover:shadow-indigo-600/30 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0b101d]"
        >
          <Plus className="w-4 h-4" />
          <span>开始新练习</span>
        </button>
      </div>

      {/* 掌握度概览卡片 */}
      <div className="p-3.5 sm:p-4 border-b border-slate-200/60 dark:border-slate-800/60 bg-gradient-to-b from-slate-50/70 to-slate-100/30 dark:from-slate-900/40 dark:to-slate-900/10 shrink-0">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2.5">
          <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
            <TrendingUp className="w-3.5 h-3.5 text-indigo-500" />
            掌握情况总览
          </span>
          <span className="text-xxs font-medium px-1.5 py-0.5 rounded-md bg-slate-200/60 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
            {masteryStats.totalAttempted} 场测验
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="p-2.5 rounded-xl bg-white/95 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700/60 shadow-xs">
            <div className="text-xxs text-slate-500 dark:text-slate-400 font-medium">已掌握题目</div>
            <div className="text-base sm:text-lg font-bold text-slate-850 dark:text-slate-100 mt-0.5 tracking-tight">
              {masteryStats.totalCorrect}
              <span className="text-xs font-normal text-slate-400 dark:text-slate-500"> / {masteryStats.totalQuestions}</span>
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-white/95 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700/60 shadow-xs">
            <div className="text-xxs text-slate-500 dark:text-slate-400 font-medium">总体掌握率</div>
            <div className="text-base sm:text-lg font-bold text-indigo-600 dark:text-indigo-400 mt-0.5 tracking-tight flex items-baseline gap-1">
              <span>{masteryStats.rate}%</span>
            </div>
          </div>
        </div>

        {/* 总体掌握率进度条 */}
        <div className="mt-2.5 w-full bg-slate-200/70 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full rounded-full transition-all duration-500 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, masteryStats.rate))}%` }}
          />
        </div>
      </div>

      {/* 往期练习历史列表 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0">
        <div className="px-1 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-between">
          <span className="tracking-tight">往期练习记录</span>
          <div className="flex items-center gap-2">
            {historyView.offline && <span className="text-xxs font-medium text-amber-500">离线缓存</span>}
            {historyView.items.length > 0 && (
              <button
                type="button"
                onClick={onClearHistory}
                className="text-xxs text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 transition-colors cursor-pointer px-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30"
              >
                清空
              </button>
            )}
          </div>
        </div>

        {/* 历史记录过滤标签切换（全部 / 待复盘错题） */}
        {historyView.items.length > 0 && (
          <div className="flex items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-900/90 rounded-lg border border-slate-200/80 dark:border-slate-800/80 mb-2">
            <button
              type="button"
              onClick={() => onSetHistoryFilter('all')}
              className={`flex-1 py-1 text-xxs font-medium rounded-md transition cursor-pointer ${
                historyFilter === 'all'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              全部 ({historyView.items.length})
            </button>
            <button
              type="button"
              onClick={() => onSetHistoryFilter('mistakes')}
              className={`flex-1 py-1 text-xxs font-medium rounded-md transition cursor-pointer ${
                historyFilter === 'mistakes'
                  ? 'bg-white dark:bg-slate-800 text-rose-600 dark:text-rose-400 shadow-xs'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              待复盘 ({mistakeItemsCount})
            </button>
          </div>
        )}

        {historyView.historyError && (
          <div className="px-2 text-xxs text-rose-500 dark:text-rose-400">{historyView.historyError}</div>
        )}

        {displayedHistoryItems.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400 dark:text-slate-500 space-y-2">
            <BookOpen className="w-8 h-8 mx-auto opacity-30" />
            <p className="font-medium">
              {historyFilter === 'mistakes' ? '暂无待复盘记录，满分掌握！' : '暂无往期练习记录'}
            </p>
            <p className="text-xxs text-slate-400">
              {historyFilter === 'mistakes' ? '可切换到「全部」查看历史' : '输入主题开始第一次测验吧'}
            </p>
          </div>
        ) : (
          <>
            {displayedHistoryItems.map((item) => {
              const isSelected = currentAttemptId === item.attemptId;
              const hasMistake = item.status === 'completed' && item.correctCount !== null && item.correctCount < item.total;

              return (
                <div
                  key={item.attemptId}
                  className={`w-full p-2.5 sm:p-3 rounded-xl border transition-all group ${
                    isSelected
                      ? 'bg-indigo-50/90 dark:bg-indigo-950/40 border-indigo-400/80 dark:border-indigo-600/80 shadow-xs ring-1 ring-indigo-500/10'
                      : 'bg-white/90 dark:bg-slate-900/60 border-slate-200/70 dark:border-slate-800/70 hover:border-indigo-200 dark:hover:border-slate-700 hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => onStartNewWithTopic(item.topic, item.difficulty)}
                      className="flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="text-xs font-semibold text-slate-850 dark:text-slate-200 line-clamp-1 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                          {item.topic}
                        </span>
                        <span className="text-xxs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800/90 text-slate-500 dark:text-slate-400 shrink-0 font-medium">
                          {DIFFICULTY_LABELS[item.difficulty]}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-xxs text-slate-400 mt-2">
                        <span>
                          {item.status === 'completed' && item.correctCount !== null ? (
                            <span className={`font-semibold inline-flex items-center gap-1 ${
                              hasMistake
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-emerald-600 dark:text-emerald-400'
                            }`}>
                              {hasMistake ? (
                                <AlertCircle className="w-3 h-3 shrink-0" />
                              ) : (
                                <CheckCircle2 className="w-3 h-3 shrink-0" />
                              )}
                              掌握 {item.correctCount}/{item.total}
                            </span>
                          ) : (
                            <span className="text-amber-500 font-medium">未完成</span>
                          )}
                        </span>
                        <span>{new Date(item.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span>
                      </div>
                    </button>

                    <div className="flex items-center gap-0.5 shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        title="查看详情"
                        onClick={() => onOpenDetail(item)}
                        className="p-1 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 rounded-lg transition-colors cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title="删除记录"
                        onClick={() => onDeleteAttempt(item)}
                        className="p-1 text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {historyView.hasMore && (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={historyView.loadingMore}
                className="w-full mt-2 py-2 rounded-xl border border-slate-200 dark:border-slate-800 text-xxs text-slate-500 hover:text-indigo-600 hover:border-indigo-200 dark:hover:border-slate-700 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-1.5"
              >
                {historyView.loadingMore ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {historyView.loadingMore ? '加载中…' : '加载更多'}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
};
