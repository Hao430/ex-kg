/**
 * Spec R1 — 已交卷练习记录详情页。
 *
 * 与 graded 报告的区别：这是「历史回看」，展示完整元信息、选项全文、只看错题筛选，
 * 并提供删除/再练/返回；统计口径始终用全量 summary，不随筛选变化。
 */
import React, { useMemo, useState } from 'react';
import { ArrowLeft, Compass, RotateCcw, Trash2 } from 'lucide-react';
import type {
  QuizAttemptDetail,
  QuizGradeResult,
  QuizGradeSummary,
} from '../../lib/quiz-store';
import { countWrong, filterGradeResults, formatElapsed, sumElapsedMs } from '../../lib/quiz-detail';
import { QuizQuestionReview } from './QuizQuestionCard';

const DIFFICULTY_LABELS: Record<string, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '困难',
};

export interface CompletedDetail extends QuizAttemptDetail {
  results: QuizGradeResult[];
  summary: QuizGradeSummary;
}

interface QuizDetailViewProps {
  detail: CompletedDetail;
  onBack: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onExplore?: (topic: string) => void;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export const QuizDetailView: React.FC<QuizDetailViewProps> = ({
  detail,
  onBack,
  onDelete,
  onRetry,
  onExplore,
}) => {
  const [onlyWrong, setOnlyWrong] = useState(false);
  const wrongCount = useMemo(() => countWrong(detail.results), [detail.results]);
  const shown = useMemo(() => filterGradeResults(detail.results, onlyWrong), [detail.results, onlyWrong]);
  const totalElapsed = useMemo(() => sumElapsedMs(detail.results), [detail.results]);

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-200">
      <button
        type="button"
        onClick={onBack}
        className="self-start flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        返回练习记录
      </button>

      <div className="p-6 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-black text-slate-900 dark:text-slate-100 tracking-tight">
                {detail.topic}
              </h1>
              <span className="text-xxs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                {DIFFICULTY_LABELS[detail.difficulty] ?? detail.difficulty}
              </span>
              <span className="text-xxs px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400">
                已完成
              </span>
            </div>
            <div className="mt-1 text-xxs text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
              <span>完成于 {formatDate(detail.completedAt)}</span>
              <span>总用时 {formatElapsed(totalElapsed)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-sm transition cursor-pointer flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              再练此主题
            </button>
            {onExplore && (
              <button
                type="button"
                onClick={() => onExplore(detail.topic)}
                className="px-3 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 font-semibold text-xs rounded-xl transition cursor-pointer flex items-center gap-1.5"
              >
                <Compass className="w-3.5 h-3.5" />
                在画布中深挖
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              className="px-3 py-2 bg-white dark:bg-slate-800 text-rose-500 border border-rose-200 dark:border-rose-900/60 font-semibold text-xs rounded-xl transition cursor-pointer flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              删除
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div>
            <span className="text-xxs text-slate-400 block">掌握情况</span>
            <span className="text-2xl font-black text-emerald-600 dark:text-emerald-400">
              {detail.summary.correct} / {detail.summary.total}
            </span>
          </div>
          <div>
            <span className="text-xxs text-slate-400 block">错题</span>
            <span className="text-lg font-bold text-rose-500">{wrongCount}</span>
          </div>
          <div className="ml-auto flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900/60">
            <button
              type="button"
              onClick={() => setOnlyWrong(false)}
              className={`px-3 py-1.5 rounded-lg text-xxs font-semibold transition cursor-pointer ${
                !onlyWrong ? 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-500'
              }`}
            >
              全部 {detail.results.length}
            </button>
            <button
              type="button"
              onClick={() => setOnlyWrong(true)}
              className={`px-3 py-1.5 rounded-lg text-xxs font-semibold transition cursor-pointer ${
                onlyWrong ? 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-500'
              }`}
            >
              只看错题 {wrongCount}
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">题目精讲与误区复盘</h3>
        {shown.length === 0 ? (
          <div className="p-8 rounded-2xl bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-900/40 text-center text-xs text-emerald-600 dark:text-emerald-400">
            本次全部答对，没有错题。
            <button
              type="button"
              onClick={() => setOnlyWrong(false)}
              className="ml-2 underline underline-offset-2 cursor-pointer"
            >
              查看全部
            </button>
          </div>
        ) : (
          shown.map((r, i) => <QuizQuestionReview key={r.questionId} index={i} result={r} />)
        )}
      </div>
    </div>
  );
};
