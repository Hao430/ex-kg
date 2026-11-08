/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1/R2 — AI 出题配置工作台（Form View）。
 * 负责：
 * 1. 顶部 Hero 指南
 * 2. AI 历史薄弱知识点榜单与一键点击「针对攻坚」
 * 3. 练习主题输入与推荐灵感标签
 * 4. 认知难度选择卡片（入门/进阶/困难）
 * 5. 题量分段器（3/5/10 题）与题型偏好分段器（全部/单选/判断）
 * 6. 一键发起出题 CTA 按钮
 */
import React from 'react';
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import type {
  QuizDifficulty,
  QuizQuestionTypePreference,
  QuizStats,
} from '../../lib/quiz-store';
import {
  DEFAULT_COUNT,
  DIFFICULTY_DESCS,
  DIFFICULTY_LABELS,
  RECOMMENDED_TOPICS,
} from './constants';

export interface QuizFormViewProps {
  topic: string;
  onTopicChange: (topic: string) => void;
  difficulty: QuizDifficulty;
  onDifficultyChange: (difficulty: QuizDifficulty) => void;
  count: number;
  onCountChange: (count: number) => void;
  questionType: QuizQuestionTypePreference;
  onQuestionTypeChange: (type: QuizQuestionTypePreference) => void;
  serverStats: QuizStats | null;
  onGenerate: () => void;
  generating?: boolean;
}

export const QuizFormView: React.FC<QuizFormViewProps> = ({
  topic,
  onTopicChange,
  difficulty,
  onDifficultyChange,
  count,
  onCountChange,
  questionType,
  onQuestionTypeChange,
  serverStats,
  onGenerate,
  generating = false,
}) => {
  return (
    <div className="flex flex-col gap-5 sm:gap-6 animate-in fade-in duration-200">
      {/* 顶部 Hero 引导卡片 */}
      <div className="p-5 sm:p-6 rounded-2xl bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-sky-500/10 border border-indigo-200/60 dark:border-indigo-800/40 relative overflow-hidden backdrop-blur-xs">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 shrink-0">
            <Brain className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-base font-bold text-slate-900 dark:text-slate-100 tracking-tight">
                AI 定向测验 · 掌握度检验
              </h1>
              <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-xxs font-medium bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200/60 dark:border-indigo-800/60">
                双向深度闭环
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              基于认知心理学针对核心概念与易混误区设计测验，帮助及时巩固与发现盲区
            </p>
          </div>
        </div>
      </div>

      {/* 薄弱知识点专项攻坚卡片（基于往期做题自动聚合） */}
      {serverStats && serverStats.weakPoints.length > 0 && (
        <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-br from-amber-50/80 to-amber-100/30 dark:from-amber-950/25 dark:to-amber-900/10 border border-amber-200/80 dark:border-amber-800/60 shadow-xs flex flex-col gap-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              历史薄弱知识点（AI 学情分析）
            </span>
            <span className="text-xxs text-amber-700/80 dark:text-amber-400/80 font-medium">
              点击一键针对攻坚
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {serverStats.weakPoints.map((wp) => (
              <button
                key={wp.knowledgePoint}
                type="button"
                onClick={() => onTopicChange(`${wp.knowledgePoint} 专项强化`)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/95 dark:bg-slate-900/90 border border-amber-300/60 dark:border-amber-700/60 hover:border-amber-500 dark:hover:border-amber-500 text-xs text-slate-800 dark:text-slate-200 hover:bg-amber-50/50 dark:hover:bg-amber-950/40 transition-all cursor-pointer shadow-2xs hover:shadow-xs group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {wp.knowledgePoint}
                </span>
                <span className="text-xxs px-1.5 py-0.5 rounded-md bg-amber-100/90 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 font-medium">
                  失误 {wp.errorCount} 次 · 掌握 {Math.round(wp.masteryRate * 100)}%
                </span>
                <span className="text-xxs text-indigo-600 dark:text-indigo-400 font-bold group-hover:translate-x-0.5 transition-transform flex items-center">
                  攻坚 <ChevronRight className="w-3 h-3 ml-0.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 主配置卡片 */}
      <div className="p-5 sm:p-6 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col gap-5">
        {/* 主题输入区块 */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center justify-between">
            <span>想练习的主题或知识点</span>
            <span className="text-xxs font-normal text-slate-400">{topic.length}/200</span>
          </label>
          <div className="relative">
            <input
              type="text"
              value={topic}
              maxLength={200}
              onChange={(e) => onTopicChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && topic.trim() && !generating) {
                  onGenerate();
                }
              }}
              placeholder="例如：Transformer 多头注意力机制 / TCP 三次握手与状态流转 / 高中生物光合作用"
              className="w-full pl-4 pr-10 py-3 bg-slate-50/90 dark:bg-slate-900/60 border border-slate-300 dark:border-slate-700/80 rounded-xl outline-none focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 transition"
              data-testid="quiz-topic-input"
            />
            {topic && (
              <button
                type="button"
                onClick={() => onTopicChange('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title="清空主题"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* 推荐灵感主题 Pills */}
        <div className="flex flex-col gap-2">
          <span className="text-xxs font-medium text-slate-400 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-amber-500" />
            灵感推荐（点击快速填入）：
          </span>
          <div className="flex flex-wrap gap-1.5">
            {RECOMMENDED_TOPICS.map((rec) => (
              <button
                key={rec}
                type="button"
                onClick={() => onTopicChange(rec)}
                className="px-2.5 py-1 text-xs rounded-lg bg-slate-100/80 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-600 dark:hover:text-indigo-400 border border-slate-200/60 dark:border-slate-700/60 transition-all cursor-pointer shadow-2xs hover:shadow-xs active:scale-[0.98]"
              >
                {rec}
              </button>
            ))}
          </div>
        </div>

        {/* 难度选择三档卡片 */}
        <div className="flex flex-col gap-2.5 pt-3 border-t border-slate-100 dark:border-slate-800/80">
          <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
            认知难度档位
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {(Object.keys(DIFFICULTY_LABELS) as QuizDifficulty[]).map((d) => {
              const isSelected = difficulty === d;
              const info = DIFFICULTY_DESCS[d];
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    onDifficultyChange(d);
                    onCountChange(DEFAULT_COUNT[d]);
                  }}
                  className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between group ${
                    isSelected
                      ? 'bg-indigo-50/90 dark:bg-indigo-950/40 border-indigo-500 dark:border-indigo-400 ring-2 ring-indigo-500/15 shadow-xs'
                      : 'bg-slate-50/60 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900/60'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                        {info.title}
                      </span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                    </div>
                    <p className="text-xxs text-slate-500 dark:text-slate-400 leading-relaxed">
                      {info.desc}
                    </p>
                  </div>
                  <span className="text-xxs text-indigo-600/90 dark:text-indigo-400/90 mt-2.5 font-medium">
                    默认 {DEFAULT_COUNT[d]} 题
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 题量选择器 */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800/80">
          <div className="flex flex-col">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">测验题目数量</span>
            <span className="text-xxs text-slate-400">单选题与判断题组合呈现</span>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-900/90 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
            {[3, 5, 10].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onCountChange(n)}
                className={`px-3 py-1 text-xs rounded-lg font-semibold transition-all cursor-pointer ${
                  count === n
                    ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {n} 题
              </button>
            ))}
          </div>
        </div>

        {/* 题型偏好选择器 */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800/80">
          <div className="flex flex-col">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">题型偏好</span>
            <span className="text-xxs text-slate-400">支持单选/判断自由定制</span>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-900/90 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
            {[
              { type: 'all', label: '全部 (混合)' },
              { type: 'single', label: '仅单选题' },
              { type: 'true_false', label: '仅判断题' },
            ].map(({ type, label }) => (
              <button
                key={type}
                type="button"
                onClick={() => onQuestionTypeChange(type as QuizQuestionTypePreference)}
                className={`px-3 py-1 text-xs rounded-lg font-semibold transition-all cursor-pointer ${
                  questionType === type
                    ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 提交出题按钮 */}
        <button
          type="button"
          disabled={!topic.trim() || generating}
          onClick={onGenerate}
          className="w-full mt-2 flex items-center justify-center gap-2 px-6 py-3.5 bg-gradient-to-r from-indigo-600 via-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 active:scale-[0.99] text-white rounded-xl font-bold text-sm shadow-md shadow-indigo-600/25 hover:shadow-lg hover:shadow-indigo-600/35 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0c1222]"
        >
          <Brain className="w-4 h-4" />
          <span>生成练习试卷</span>
        </button>
      </div>
    </div>
  );
};
