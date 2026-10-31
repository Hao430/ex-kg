/**
 * Spec R1 — 判卷结果视图（交卷后的 graded 与历史回放 replay 共用）。
 *
 * ⚠️ 数据来源分离：`choice` = 用户实际作答（来自 answers），`answer` = 标准答案
 * （来自 questions.correct）。此前 UI 两处都用 answer，错题会把标准答案显示两遍。
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, Compass, RotateCcw, XCircle } from 'lucide-react';
import type { QuizGradeResult } from '../../lib/quiz-store';

interface QuizResultListProps {
  results: QuizGradeResult[];
  summary: { correct: number; total: number };
  topic: string;
  onRetry: () => void;
  onExplore?: (topic: string) => void;
  onBack: () => void;
}

function displayChoice(type: 'single' | 'true_false', value: string): string {
  if (type === 'single') return value;
  return value === 'true' ? '正确' : '错误';
}

/** 旧数据/旧夹具可能没有 choice；回退到 answer 保持原展示，不致空白 */
function userChoice(r: QuizGradeResult): string {
  return r.choice ?? r.answer;
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
          <div
            key={r.questionId}
            className="p-5 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col gap-3"
          >
            <div className="flex items-start gap-2.5">
              <span
                className={`w-6 h-6 rounded-lg font-bold text-xs flex items-center justify-center shrink-0 ${
                  r.isCorrect
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400'
                    : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'
                }`}
              >
                {i + 1}
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-850 dark:text-slate-100">{r.stem}</p>
              </div>
            </div>

            <div className="pl-8 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span
                  className={`flex items-center gap-1 font-semibold ${
                    r.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {r.isCorrect ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  <span>你的作答：{displayChoice(r.type, userChoice(r))}</span>
                </span>

                {!r.isCorrect && (
                  <span className="text-slate-500 font-medium">
                    标准正确答案：
                    <span className="text-slate-800 dark:text-slate-200 font-bold">
                      {displayChoice(r.type, r.answer)}
                    </span>
                  </span>
                )}

                {r.lowConfidence && (
                  <span className="text-xxs text-amber-500 px-1.5 py-0.5 rounded bg-amber-500/10">秒答待巩固</span>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                <span className="font-bold text-slate-700 dark:text-slate-200 block mb-1">💡 试题解析：</span>
                {r.explanation}
              </div>
            </div>
          </div>
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
