/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1/R2 — AI 练习考场作答组件（Answering View）。
 * 负责：
 * 1. 顶部测验进度看板（动态进度条 + 题目跳转胶囊）
 * 2. 逐题作答卡片（单选 / 判断、选中动效、键盘可访问性）
 * 3. 底部悬浮交卷栏（防重复提交、完成度感知）
 */
import React from 'react';
import {
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  Send,
  X,
} from 'lucide-react';
import type { QuizAttemptView, QuizDifficulty } from '../../lib/quiz-store';
import { DIFFICULTY_LABELS } from './constants';

export interface QuizAnsweringViewProps {
  attempt: QuizAttemptView;
  topic: string;
  difficulty: QuizDifficulty;
  choices: Record<string, string>;
  onPickChoice: (questionId: string, choice: string) => void;
  onSubmit: () => void;
  onAbandon: () => void;
  submitting?: boolean;
}

export const QuizAnsweringView: React.FC<QuizAnsweringViewProps> = ({
  attempt,
  topic,
  difficulty,
  choices,
  onPickChoice,
  onSubmit,
  onAbandon,
  submitting = false,
}) => {
  const total = attempt.questions.length;
  const answeredCount = attempt.questions.filter(
    (q) => choices[q.id] || choices[q.id.replace(/^q_att_/, 'q_')],
  ).length;
  const progressPercent = total > 0 ? Math.round((answeredCount / total) * 100) : 0;
  const allAnswered = answeredCount === total;

  const scrollToQuestion = (idx: number) => {
    const el = document.getElementById(`quiz-question-${idx}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  return (
    <div className="flex flex-col gap-5 animate-in fade-in duration-200">
      {/* 考场顶栏：状态概览 + 题号快速跳转 */}
      <div className="p-4 sm:p-5 rounded-2xl bg-white/95 dark:bg-[#0c1222]/95 border border-slate-200/80 dark:border-slate-800/80 shadow-xs flex flex-col gap-3.5 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
              {total} 题自测 · {topic}
            </span>
            <span className="text-xxs px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 font-semibold border border-indigo-200/50 dark:border-indigo-800/50 shrink-0">
              {DIFFICULTY_LABELS[difficulty]}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
              已作答 {answeredCount} / {total}
            </span>
            <button
              type="button"
              onClick={onAbandon}
              className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
            >
              放弃本次
            </button>
          </div>
        </div>

        {/* 动态进度条 */}
        <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className="bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 h-full rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* 快速题目跳转胶囊 */}
        <div className="flex items-center gap-1.5 pt-1 overflow-x-auto pb-0.5">
          <span className="text-xxs text-slate-400 font-medium shrink-0 mr-1">跳至题目:</span>
          {attempt.questions.map((q, i) => {
            const hasAnswer = Boolean(choices[q.id] || choices[q.id.replace(/^q_att_/, 'q_')]);
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => scrollToQuestion(i)}
                className={`w-6 h-6 rounded-lg text-xxs font-bold transition-all cursor-pointer flex items-center justify-center shrink-0 ${
                  hasAnswer
                    ? 'bg-indigo-600 text-white shadow-2xs'
                    : 'bg-slate-100 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
                title={`第 ${i + 1} 题 ${hasAnswer ? '(已作答)' : '(未作答)'}`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
      </div>

      {/* 题目卡片列表 */}
      {attempt.questions.map((q, i) => {
        const pickedVal = choices[q.id] ?? choices[q.id.replace(/^q_att_/, 'q_')];
        const isAnswered = Boolean(pickedVal);

        return (
          <div
            key={q.id}
            id={`quiz-question-${i}`}
            className={`p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#0c1222] border transition-all duration-200 shadow-xs flex flex-col gap-4 ${
              isAnswered
                ? 'border-slate-200/90 dark:border-slate-800/90'
                : 'border-slate-200 dark:border-slate-800'
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                className={`w-7 h-7 rounded-xl font-bold text-xs flex items-center justify-center shrink-0 transition-colors ${
                  isAnswered
                    ? 'bg-indigo-600 text-white shadow-2xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                }`}
              >
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-xxs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                  {q.type === 'single' ? '单选题' : '判断题'}
                </span>
                <p className="text-sm font-semibold text-slate-850 dark:text-slate-100 leading-relaxed">
                  {q.stem}
                </p>
              </div>
            </div>

            {/* 单选题选项列表 */}
            {q.type === 'single' && q.options ? (
              <div className="flex flex-col gap-2 pt-1 pl-0 sm:pl-10">
                {q.options.map((o) => {
                  const isPicked = pickedVal === o.label;
                  return (
                    <button
                      key={o.label}
                      type="button"
                      onClick={() => onPickChoice(q.id, o.label)}
                      className={`flex items-start gap-3 p-3.5 rounded-xl border text-left text-xs transition-all cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                        isPicked
                          ? 'border-indigo-600 bg-indigo-50/80 dark:bg-indigo-950/40 dark:border-indigo-500 font-medium shadow-xs'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50/60 dark:hover:bg-slate-900/50'
                      }`}
                    >
                      <span
                        className={`w-5 h-5 rounded-md text-xs font-bold flex items-center justify-center shrink-0 transition-colors ${
                          isPicked
                            ? 'bg-indigo-600 text-white shadow-2xs'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 group-hover:bg-slate-200 dark:group-hover:bg-slate-700'
                        }`}
                      >
                        {o.label}
                      </span>
                      <span className="flex-1 pt-0.5 text-slate-800 dark:text-slate-200 leading-relaxed">
                        {o.text}
                      </span>
                      {isPicked && (
                        <Check className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              /* 判断题选项 */
              <div className="flex gap-3 pl-0 sm:pl-10">
                {[
                  ['true', '✓ 正确'],
                  ['false', '✕ 错误'],
                ].map(([val, label]) => {
                  const isPicked = pickedVal === val;
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => onPickChoice(q.id, val)}
                      className={`flex-1 py-3 px-4 rounded-xl border font-semibold text-xs text-center transition-all cursor-pointer flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                        isPicked
                          ? 'border-indigo-600 bg-indigo-50/80 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 shadow-xs'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50/60 dark:hover:bg-slate-900/50'
                      }`}
                    >
                      <span>{label}</span>
                      {isPicked && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* 底部悬浮交卷栏 */}
      <div className="p-4 rounded-2xl bg-white/95 dark:bg-[#0c1222]/95 border border-slate-200/90 dark:border-slate-800/90 shadow-lg shadow-slate-900/5 dark:shadow-black/20 flex items-center justify-between sticky bottom-4 backdrop-blur-md z-30">
        <div className="flex items-center gap-2">
          {allAnswered ? (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              已全部作答完毕，准备交卷
            </span>
          ) : (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              还有 <strong className="text-indigo-600 dark:text-indigo-400 font-bold">{total - answeredCount}</strong> 道题未作答
            </span>
          )}
        </div>

        <button
          type="button"
          disabled={!allAnswered || submitting}
          onClick={onSubmit}
          className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-indigo-600 via-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 active:scale-[0.99] text-white rounded-xl font-bold text-xs sm:text-sm shadow-md shadow-indigo-600/20 hover:shadow-indigo-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>提交中…</span>
            </>
          ) : (
            <>
              <Send className="w-3.5 h-3.5" />
              <span>提交交卷</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
