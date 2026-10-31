/**
 * Spec R1 — 单题展示卡（交卷报告 / 历史详情共用）。
 *
 * 数据来源分离：choice = 用户作答，answer = 标准答案，options = 选项全文。
 * 旧记录可能没有 options（2026-10 之前入库）；此时回退到只显示标签，不崩。
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { QuizGradeResult, QuizOption, QuizQuestion } from '../../lib/quiz-store';

function displayChoice(type: 'single' | 'true_false', value: string): string {
  if (type === 'single') return value;
  return value === 'true' ? '正确' : '错误';
}

function optionsOf(result: QuizGradeResult): QuizOption[] | null {
  if (result.options && result.options.length > 0) return result.options;
  if (result.type === 'true_false') {
    return [
      { label: 'true', text: '正确' },
      { label: 'false', text: '错误' },
    ];
  }
  return null;
}

function userChoiceOf(result: QuizGradeResult): string {
  return result.choice ?? result.answer;
}

export const QuizQuestionReview: React.FC<{ index: number; result: QuizGradeResult }> = ({ index, result }) => {
  const options = optionsOf(result);
  const userChoice = userChoiceOf(result);

  return (
    <div className="p-5 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span
          className={`w-6 h-6 rounded-lg font-bold text-xs flex items-center justify-center shrink-0 ${
            result.isCorrect
              ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400'
              : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'
          }`}
        >
          {index + 1}
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-850 dark:text-slate-100">{result.stem}</p>
        </div>
      </div>

      <div className="pl-8 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span
            className={`flex items-center gap-1 font-semibold ${
              result.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
            }`}
          >
            {result.isCorrect ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            <span>你的作答：{displayChoice(result.type, userChoice)}</span>
          </span>

          {!result.isCorrect && (
            <span className="text-slate-500 font-medium">
              标准正确答案：
              <span className="text-slate-800 dark:text-slate-200 font-bold">
                {displayChoice(result.type, result.answer)}
              </span>
            </span>
          )}

          {result.lowConfidence && (
            <span className="text-xxs text-amber-500 px-1.5 py-0.5 rounded bg-amber-500/10">秒答待巩固</span>
          )}
        </div>

        {options && (
          <div className="flex flex-col gap-1.5">
            {options.map((o) => {
              const isAnswer = o.label === result.answer;
              const isUser = o.label === userChoice;
              return (
                <div
                  key={o.label}
                  className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
                    isAnswer
                      ? 'border-emerald-300/80 bg-emerald-50/70 dark:border-emerald-700/60 dark:bg-emerald-950/30'
                      : isUser
                        ? 'border-rose-300/80 bg-rose-50/70 dark:border-rose-700/60 dark:bg-rose-950/30'
                        : 'border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40'
                  }`}
                >
                  <span className="font-bold text-slate-500 shrink-0">{o.label === 'true' ? '✓' : o.label === 'false' ? '✗' : o.label}.</span>
                  <span className="flex-1 text-slate-700 dark:text-slate-200">{o.text}</span>
                  {isAnswer && (
                    <span className="text-xxs text-emerald-600 dark:text-emerald-400 shrink-0">
                      {isUser ? '你的选择 · 正确答案' : '正确答案'}
                    </span>
                  )}
                  {isUser && !isAnswer && (
                    <span className="text-xxs text-rose-500 shrink-0">你的选择</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          <span className="font-bold text-slate-700 dark:text-slate-200 block mb-1">💡 试题解析：</span>
          {result.explanation}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xxs text-slate-400">
          {result.knowledgePoint && (
            <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300">
              知识点：{result.knowledgePoint}
            </span>
          )}
          <span>用时 {(result.elapsedMs / 1000).toFixed(1)}s</span>
        </div>
      </div>
    </div>
  );
};

/** 未交卷详情：只读题干/选项，不显示作答、答案、解析 */
export const QuizQuestionPreview: React.FC<{ index: number; question: QuizQuestion }> = ({ index, question }) => {
  const options: QuizOption[] | null = question.options ?? (question.type === 'true_false'
    ? [{ label: 'true', text: '正确' }, { label: 'false', text: '错误' }]
    : null);

  return (
    <div className="p-4 rounded-xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className="w-6 h-6 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 font-bold text-xs flex items-center justify-center shrink-0">
          {index + 1}
        </span>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{question.stem}</p>
      </div>
      {options && (
        <div className="pl-8 flex flex-col gap-1">
          {options.map((o) => (
            <div key={o.label} className="text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold mr-1">{o.label === 'true' ? '✓' : o.label === 'false' ? '✗' : `${o.label}.`}</span>
              {o.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
