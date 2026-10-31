/**
 * Spec R1 — 未交卷记录详情：只读题目 + 继续作答。
 * 选项/题干来自服务端安全投影，绝不含答案与解析。
 */
import React from 'react';
import { ArrowLeft, Play, Trash2 } from 'lucide-react';
import type { QuizAttemptDetail, QuizQuestion } from '../../lib/quiz-store';
import { QuizQuestionPreview } from './QuizQuestionCard';

const DIFFICULTY_LABELS: Record<string, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '困难',
};

export interface PendingDetail extends QuizAttemptDetail {
  questions: QuizQuestion[];
}

export const QuizPendingView: React.FC<{
  detail: PendingDetail;
  onResume: () => void;
  onDelete: () => void;
  onBack: () => void;
  onExplore?: (topic: string) => void;
}> = ({ detail, onResume, onDelete, onBack, onExplore }) => (
  <div className="flex flex-col gap-6 animate-in fade-in duration-200">
    <button
      type="button"
      onClick={onBack}
      className="self-start flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 transition-colors cursor-pointer"
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      返回练习记录
    </button>

    <div className="p-6 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-black text-slate-900 dark:text-slate-100 tracking-tight">{detail.topic}</h1>
            <span className="text-xxs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
              {DIFFICULTY_LABELS[detail.difficulty] ?? detail.difficulty}
            </span>
            <span className="text-xxs px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400">
              未完成
            </span>
          </div>
          <p className="mt-1 text-xxs text-slate-400">
            共 {detail.questions.length} 道题 · 交卷后可查看答案与解析
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onResume}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-sm transition cursor-pointer flex items-center gap-1.5"
          >
            <Play className="w-3.5 h-3.5" />
            继续作答
          </button>
          {onExplore && (
            <button
              type="button"
              onClick={() => onExplore(detail.topic)}
              className="px-3 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 font-semibold text-xs rounded-xl transition cursor-pointer"
            >
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
    </div>

    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">题目预览</h3>
      {detail.questions.map((q, i) => (
        <QuizQuestionPreview key={q.id} index={i} question={q} />
      ))}
    </div>
  </div>
);
