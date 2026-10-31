/**
 * Spec R1 — 判卷结果视图（交卷后的 graded 与历史回放 replay 共用）。
 *
 * 单题渲染见 QuizQuestionCard；本组件只负责成绩卡、低置信提示与列表容器。
 */
import React from 'react';
import { AlertTriangle, Compass, RotateCcw } from 'lucide-react';
import type { QuizGradeResult } from '../../lib/quiz-store';
import { QuizQuestionReview } from './QuizQuestionCard';

interface QuizResultListProps {
  results: QuizGradeResult[];
  summary: { correct: number; total: number };
  topic: string;
  onRetry: () => void;
  onExplore?: (topic: string) => void;
  onBack: () => void;
}

export const QuizResultList: React.FC<QuizResultListProps> = ({
  results,
  summary,
  topic,
  onRetry,
  onExplore,
  onBack,
}) => {
  const lowConfidenceCount = results.filter((r) => r.lowConfidence).length;

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-200">
      {/* 成绩卡片 */}
      <div className="p-6 rounded-2xl bg-gradient-to-br from-indigo-500/10 via-emerald-500/10 to-sky-500/10 border border-emerald-500/20 dark:border-emerald-500/20 shadow-sm flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">本次测验掌握情况</span>
            <h2 className="text-2xl font-black text-slate-900 dark:text-slate-100 tracking-tight mt-0.5">
              掌握 {summary.correct} / {summary.total}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-sm transition cursor-pointer flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>再练一组</span>
            </button>
            {onExplore && (
              <button
                type="button"
                onClick={() => onExplore(topic)}
                className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:text-indigo-600 font-semibold text-xs rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition cursor-pointer flex items-center gap-1.5"
              >
                <Compass className="w-3.5 h-3.5" />
                <span>在画布中深挖</span>
              </button>
            )}
          </div>
        </div>

        {lowConfidenceCount > 0 && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              其中 {lowConfidenceCount} 题作答极快（≤2s），可能为碰巧猜对，暂未计入稳定掌握。
            </span>
          </div>
        )}
      </div>

      {/* 逐题详细解析 */}
      <div className="flex flex-col gap-4">
        <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">题目精讲与误区复盘</h3>
        {results.map((r, i) => (
          <QuizQuestionReview key={r.questionId} index={i} result={r} />
        ))}
      </div>

      <div className="flex items-center justify-center gap-3 pt-4">
        <button
          type="button"
          onClick={onBack}
          className="px-6 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 font-medium text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
        >
          开始其他主题练习
        </button>
      </div>
    </div>
  );
};
