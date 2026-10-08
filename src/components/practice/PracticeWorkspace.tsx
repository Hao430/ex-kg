/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1 — AI 练习模式独立工作台（Practice Workspace）。
 *
 * 产品定位：与「思维画布」平级的第二产品。
 * - 顶栏支持双产品一键切换（思维画布 ↔ AI 练习）
 * - 采用现代全屏工作台架构：左侧历史练习与掌握度档案 + 右侧沉浸式主舞台
 * - 状态机：出题工作室 (form) → 生成中 (loading) → 沉浸考场 (answering) → 诊断报告 (graded)
 * - 遵循文案纪律：面向用户使用「掌握情况」，不使用「正确率」或内部技术术语
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Compass,
  Brain,
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  ArrowRight,
  RotateCcw,
  Plus,
  BookOpen,
  ChevronRight,
  Sun,
  Moon,
  Crown,
  User,
  History,
  TrendingUp,
  Check,
  Flame,
  Lightbulb,
} from 'lucide-react';
import * as quizStore from '../../lib/quiz-store';
import { scopeKeyFor } from '../../lib/board-scope';
import type { QuizAttemptView, QuizDifficulty, QuizGradeResult, QuizSubmission } from '../../lib/quiz-store';
import { useAuth } from '../../context/AuthContext';
import { Tooltip } from '../ui/Tooltip';

const DIFFICULTY_LABELS: Record<QuizDifficulty, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '困难',
};

const DIFFICULTY_DESCS: Record<QuizDifficulty, { title: string; desc: string; detail: string }> = {
  beginner: {
    title: '入门 · 概念辨识',
    desc: '核心概念、定义直给与基础记忆',
    detail: '适合初学或快速热身，聚焦学科基础术语辨识',
  },
  intermediate: {
    title: '进阶 · 机制推理',
    desc: '单步推理、因果逻辑与应用场景',
    detail: '考查理解深度与关联推导，检验是否真正吃透机制',
  },
  advanced: {
    title: '困难 · 综合迁移',
    desc: '复杂情境分析、边界条件与误区辨析',
    detail: '高阶心智挑战，题干更丰富，需多步推理综合判断',
  },
};

/** 困难档题量默认 3，入门与进阶默认 5（选择器始终可改） */
const DEFAULT_COUNT: Record<QuizDifficulty, number> = {
  beginner: 5,
  intermediate: 5,
  advanced: 3,
};

/** 推荐练习主题 Pills */
const RECOMMENDED_TOPICS = [
  'Transformer 多头注意力机制',
  'TCP 三次握手与状态流转',
  '高中生物光合作用光反应',
  '微积分基本定理与几何意义',
  'Raft 分布式共识机制',
  '快速排序与时间复杂度分析',
  '量子计算叠加态与量子纠缠',
  '边际效用递减与机会成本',
];

interface PracticeWorkspaceProps {
  userId: string | null;
  user: any;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  activeProduct: 'canvas' | 'practice';
  onSwitchProduct: (product: 'canvas' | 'practice') => void;
  onGoToLanding: () => void;
  onExploreInCanvas?: (topic: string) => void;
  initialTopic?: string;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'loading' }
  | { kind: 'answering'; attempt: QuizAttemptView; startedAt: number }
  | { kind: 'graded'; attempt: QuizAttemptView; results: QuizGradeResult[]; summary: { correct: number; total: number } }
  | { kind: 'error'; message: string };

export const PracticeWorkspace: React.FC<PracticeWorkspaceProps> = ({
  userId,
  user,
  theme,
  onToggleTheme,
  activeProduct,
  onSwitchProduct,
  onGoToLanding,
  onExploreInCanvas,
  initialTopic = '',
}) => {
  const [topic, setTopic] = useState(initialTopic);
  const [difficulty, setDifficulty] = useState<QuizDifficulty>('beginner');
  const [count, setCount] = useState(5);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [choices, setChoices] = useState<Record<string, string>>({});
  const historyView = useSyncExternalStore(quizStore.subscribe, quizStore.getHistoryView);
  const startRef = useRef<Record<string, number>>({});
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const { isVip, openAuthModal, openRechargeModal, openUserProfileModal } = useAuth();

  // 账号切换 scope 绑定
  useEffect(() => {
    if (userId) {
      quizStore.bindScope(scopeKeyFor(userId));
      void quizStore.refreshHistory();
    } else {
      quizStore.reset();
    }
    setPhase({ kind: 'form' });
    setChoices({});
  }, [userId]);

  // 返回表单态时自动刷新历史记录
  useEffect(() => {
    if (phase.kind === 'form' && userId) {
      void quizStore.refreshHistory();
    }
  }, [phase.kind, userId]);

  // 如果初始带了 topic，填入
  useEffect(() => {
    if (initialTopic) {
      setTopic(initialTopic);
    }
  }, [initialTopic]);

  const handleGenerate = useCallback(async () => {
    if (!topic.trim()) return;
    setPhase({ kind: 'loading' });
    const outcome = await quizStore.generateQuiz({ topic: topic.trim(), difficulty, count });
    if (!outcome.ok) {
      setPhase({ kind: 'error', message: (outcome as { error?: string }).error || '出题失败，请稍后重试' });
      return;
    }
    const attempt = (outcome as { data: QuizAttemptView }).data;
    // 恢复未提交草稿
    const draft = quizStore.loadDraft(attempt.attemptId);
    const restored: Record<string, string> = {};
    for (const [qid, sub] of Object.entries(draft)) {
      if (sub && typeof sub.choice === 'string') restored[qid] = sub.choice;
    }
    setChoices(restored);
    startRef.current = {};
    setPhase({ kind: 'answering', attempt, startedAt: Date.now() });
  }, [topic, difficulty, count]);

  const handleSubmit = useCallback(async () => {
    if (phase.kind !== 'answering') return;
    const { attempt } = phase;
    const now = Date.now();

    // 逐题耗时计算（首题相对开卷时刻，其余相对上一题首答时刻）
    const stamps = attempt.questions
      .map((q) => startRef.current[q.id])
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    const byQuestion = new Map<string, number>();
    for (let i = 0; i < attempt.questions.length; i++) {
      const q = attempt.questions[i];
      const stamp = startRef.current[q.id];
      if (typeof stamp !== 'number') {
        byQuestion.set(q.id, now - phase.startedAt);
        continue;
      }
      let prev = phase.startedAt;
      for (const s of stamps) {
        if (s < stamp) prev = s;
      }
      byQuestion.set(q.id, stamp - prev);
    }
    const answers: QuizSubmission[] = attempt.questions.map((q) => ({
      questionId: q.id,
      choice: choices[q.id] ?? '',
      elapsedMs: Math.max(100, byQuestion.get(q.id) ?? 1000),
    }));

    const outcome = await quizStore.submitAnswers(attempt.attemptId, answers);
    if (!outcome.ok) {
      setPhase({ kind: 'error', message: (outcome as { error?: string }).error || '提交失败，请稍后重试' });
      return;
    }
    const graded = outcome as { results: QuizGradeResult[]; summary: { correct: number; total: number } };
    quizStore.clearDraft(attempt.attemptId);
    setPhase({
      kind: 'graded',
      attempt,
      results: graded.results,
      summary: { correct: graded.summary.correct, total: graded.summary.total },
    });
  }, [phase, choices]);

  const pickChoice = useCallback((questionId: string, choice: string) => {
    if (!startRef.current[questionId]) startRef.current[questionId] = Date.now();
    setChoices((prev) => {
      const next = { ...prev, [questionId]: choice };
      if (phaseRef.current?.kind === 'answering') {
        quizStore.saveDraft(phaseRef.current.attempt.attemptId, {
          ...Object.fromEntries(Object.entries(next).map(([qid, c]) => [
            qid, { questionId: qid, choice: c, elapsedMs: 0 },
          ])),
        });
      }
      return next;
    });
  }, []);

  const answeredCount = useMemo(
    () => (phase.kind === 'answering' ? phase.attempt.questions.filter((q) => choices[q.id]).length : 0),
    [phase, choices],
  );

  // 历史练习总计
  const masteryStats = useMemo(() => {
    const completed = historyView.items.filter((h) => h.status === 'completed' && h.correctCount !== null);
    const totalAttempted = historyView.items.length;
    const totalCorrect = completed.reduce((acc, h) => acc + (h.correctCount || 0), 0);
    const totalQuestions = completed.reduce((acc, h) => acc + h.total, 0);
    const rate = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
    return { totalAttempted, totalCorrect, totalQuestions, rate };
  }, [historyView.items]);

  const handleStartNewWithTopic = (t: string, d?: QuizDifficulty) => {
    setTopic(t);
    if (d) {
      setDifficulty(d);
      setCount(DEFAULT_COUNT[d]);
    }
    setChoices({});
    setPhase({ kind: 'form' });
  };

  return (
    <div className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#070b14] text-slate-850 dark:text-slate-100 font-sans transition-colors duration-200">
      {/* ================= 顶层全局导航 Header ================= */}
      <header className="h-14 bg-white/80 dark:bg-[#070b14]/85 backdrop-blur-xl border-b border-slate-200/70 dark:border-slate-800/70 px-4 flex items-center justify-between z-40 shrink-0">
        <div className="flex items-center gap-3">
          {/* Logo */}
          <button
            onClick={onGoToLanding}
            className="flex items-center gap-2 group cursor-pointer focus:outline-none"
            title="返回产品介绍首页"
          >
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-sky-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 group-hover:scale-105 transition-transform">
              <Compass className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-slate-850 dark:text-slate-100 text-sm tracking-tight hidden sm:inline group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              枝想<span className="text-indigo-600 dark:text-indigo-400 font-semibold">Arborize</span>
            </span>
          </button>

          <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800" />

          {/* ================= 双产品切换胶囊 ================= */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-xl border border-slate-200/60 dark:border-slate-700/60 text-xs font-medium">
            <button
              type="button"
              onClick={() => onSwitchProduct('canvas')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
                activeProduct === 'canvas'
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Compass className="w-3.5 h-3.5 text-indigo-500" />
              <span>思维画布</span>
            </button>
            <button
              type="button"
              onClick={() => onSwitchProduct('practice')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
                activeProduct === 'practice'
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Brain className="w-3.5 h-3.5 text-purple-500" />
              <span>AI 练习</span>
            </button>
          </div>
        </div>

        {/* 右侧控制区 */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* VIP 状态 / 升级 */}
          {user && (
            <button
              onClick={() => openRechargeModal('练习模式顶部按钮')}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg font-medium transition ${
                isVip
                  ? 'bg-amber-500/10 text-amber-500 border border-amber-500/30'
                  : 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-800/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/40'
              }`}
            >
              <Crown className="w-3.5 h-3.5 text-amber-500" />
              <span>{isVip ? 'VIP 会员' : '升级 Pro'}</span>
            </button>
          )}

          {/* 主题切换 */}
          <button
            onClick={onToggleTheme}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition"
            title={theme === 'dark' ? '切换为亮色模式' : '切换为深色模式'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* 登录/个人中心 */}
          {user ? (
            <button
              onClick={openUserProfileModal}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition"
            >
              <User className="w-3.5 h-3.5 text-slate-500" />
              <span className="hidden sm:inline max-w-[100px] truncate">{user.nickname || user.email}</span>
            </button>
          ) : (
            <button
              onClick={() => openAuthModal('signin')}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm transition"
            >
              登录 / 注册
            </button>
          )}
        </div>
      </header>

      {/* ================= 双栏主工作台 Body ================= */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* 左侧边栏：历史练习与掌握度资产 */}
        <aside className="w-80 shrink-0 border-r border-slate-200 dark:border-slate-800/80 bg-white/70 dark:bg-[#0b101d]/60 backdrop-blur-md flex flex-col min-h-0">
          {/* 顶部主 CTA 按钮 */}
          <div className="p-4 border-b border-slate-200/60 dark:border-slate-800/60 shrink-0">
            <button
              type="button"
              onClick={() => {
                setTopic('');
                setPhase({ kind: 'form' });
                setChoices({});
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white font-medium text-sm shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>开始新练习</span>
            </button>
          </div>

          {/* 掌握度概览卡片 */}
          <div className="p-4 border-b border-slate-200/60 dark:border-slate-800/60 bg-slate-50/50 dark:bg-slate-900/40 shrink-0">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
              <span className="flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-indigo-500" />
                掌握情况总览
              </span>
              <span className="text-[11px] text-slate-400">{masteryStats.totalAttempted} 场测验</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2.5 rounded-lg bg-white dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">已掌握题目</div>
                <div className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-0.5">
                  {masteryStats.totalCorrect}
                  <span className="text-xs font-normal text-slate-400"> / {masteryStats.totalQuestions}</span>
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-white dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">总体掌握率</div>
                <div className="text-lg font-bold text-indigo-600 dark:text-indigo-400 mt-0.5">
                  {masteryStats.rate}%
                </div>
              </div>
            </div>
          </div>

          {/* 往期练习历史列表 */}
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0">
            <div className="px-2 py-1 text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-between">
              <span>往期练习记录</span>
              {historyView.offline && <span className="text-[10px] text-amber-500">离线缓存</span>}
            </div>

            {historyView.items.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400 dark:text-slate-500 space-y-2">
                <BookOpen className="w-8 h-8 mx-auto opacity-30" />
                <p>暂无往期练习记录</p>
                <p className="text-[11px] text-slate-400">输入主题开始第一次测验吧</p>
              </div>
            ) : (
              historyView.items.map((item) => {
                const isSelected = phase.kind !== 'form' && (phase as any).attempt?.attemptId === item.attemptId;
                return (
                  <button
                    key={item.attemptId}
                    type="button"
                    onClick={() => handleStartNewWithTopic(item.topic, item.difficulty)}
                    className={`w-full text-left p-3 rounded-xl border transition-all group cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700/80 shadow-sm'
                        : 'bg-white dark:bg-slate-900/60 border-slate-200/70 dark:border-slate-800/70 hover:border-indigo-200 dark:hover:border-slate-700 hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 line-clamp-1 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                        {item.topic}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">
                        {DIFFICULTY_LABELS[item.difficulty]}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-2">
                      <span>
                        {item.status === 'completed' && item.correctCount !== null ? (
                          <span className="font-medium text-emerald-600 dark:text-emerald-400">
                            掌握 {item.correctCount}/{item.total}
                          </span>
                        ) : (
                          <span className="text-amber-500">未完成</span>
                        )}
                      </span>
                      <span>{new Date(item.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* 右侧主舞台：出题工作室 / 考场 / 判卷诊断报告 */}
        <main className="flex-1 overflow-y-auto px-4 py-8 sm:px-12 flex justify-center bg-slate-50/50 dark:bg-[#070b14]/50">
          <div className="w-full max-w-3xl flex flex-col gap-6" data-testid="quiz-panel">
            {/* 状态 1：出题工作室 (Form View) */}
            {phase.kind === 'form' && (
              <div className="flex flex-col gap-6 animate-in fade-in duration-200">
                {/* 顶部 Hero 引导卡片 */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-sky-500/10 border border-indigo-200/50 dark:border-indigo-800/40 relative overflow-hidden">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
                      <Brain className="w-5 h-5" />
                    </div>
                    <div>
                      <h1 className="text-base font-bold text-slate-900 dark:text-slate-100 tracking-tight">
                        AI 练习模式 · 定向测验与掌握度检验
                      </h1>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        针对核心概念与易混误区设计选择题与判断题，检验真实理解深度
                      </p>
                    </div>
                  </div>
                </div>

                {/* 主题输入区块 */}
                <div className="p-6 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                      <span>想练习的主题或知识点</span>
                      <span className="text-[11px] font-normal text-slate-400">{topic.length}/200</span>
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={topic}
                        maxLength={200}
                        onChange={(e) => setTopic(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && topic.trim()) void handleGenerate(); }}
                        placeholder="例如：Transformer 多头注意力机制 / TCP 三次握手与状态流转 / 高中生物光合作用"
                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900/60 border border-slate-300 dark:border-slate-700/80 rounded-xl outline-none focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/10 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 transition"
                        data-testid="quiz-topic-input"
                      />
                      {topic && (
                        <button
                          type="button"
                          onClick={() => setTopic('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 推荐灵感主题 Pills */}
                  <div className="flex flex-col gap-2 pt-1">
                    <span className="text-[11px] font-medium text-slate-400 flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-amber-500" />
                      灵感推荐（点击快速填入）：
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {RECOMMENDED_TOPICS.map((rec) => (
                        <button
                          key={rec}
                          type="button"
                          onClick={() => setTopic(rec)}
                          className="px-2.5 py-1 text-xs rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-600 dark:hover:text-indigo-400 border border-slate-200/60 dark:border-slate-700/60 transition cursor-pointer"
                        >
                          {rec}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 难度选择三档卡片 */}
                  <div className="flex flex-col gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
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
                              setDifficulty(d);
                              setCount(DEFAULT_COUNT[d]);
                            }}
                            className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                              isSelected
                                ? 'bg-indigo-50/80 dark:bg-indigo-950/40 border-indigo-500 dark:border-indigo-400 ring-2 ring-indigo-500/10 shadow-sm'
                                : 'bg-slate-50/60 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                                  {info.title}
                                </span>
                                {isSelected && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                              </div>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                                {info.desc}
                              </p>
                            </div>
                            <span className="text-[10px] text-indigo-600/80 dark:text-indigo-400/80 mt-2 font-medium">
                              默认 {DEFAULT_COUNT[d]} 题
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 题量选择器 */}
                  <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800/80">
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300">测验题目数量</span>
                      <span className="text-[11px] text-slate-400">单选题与判断题组合呈现</span>
                    </div>
                    <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-900 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
                      {[3, 5, 10].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setCount(n)}
                          className={`px-3 py-1 text-xs rounded-lg font-semibold transition cursor-pointer ${
                            count === n
                              ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm'
                              : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                          }`}
                        >
                          {n} 题
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 提交出题按钮 */}
                  <button
                    type="button"
                    disabled={!topic.trim()}
                    onClick={() => void handleGenerate()}
                    className="w-full mt-2 flex items-center justify-center gap-2 px-6 py-3.5 bg-gradient-to-r from-indigo-600 via-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl font-bold text-sm shadow-md shadow-indigo-600/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
                  >
                    <Brain className="w-4 h-4" />
                    <span>生成练习试卷</span>
                  </button>
                </div>
              </div>
            )}

            {/* 状态 2：生成中 (Loading View) */}
            {phase.kind === 'loading' && (
              <div className="p-12 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col items-center justify-center gap-4 text-center animate-in fade-in duration-200">
                <div className="relative">
                  <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                    <Loader2 className="w-7 h-7 animate-spin" />
                  </div>
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">
                    AI 正在构思测验题目…
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm">
                    正在分析「{topic}」的学科知识图谱，针对常见混淆误区构造干扰项与自审校验
                  </p>
                </div>
              </div>
            )}

            {/* 状态 3：异常提示 (Error View) */}
            {phase.kind === 'error' && (
              <div className="p-8 rounded-2xl bg-white dark:bg-[#0c1222] border border-red-200 dark:border-red-900/60 shadow-sm flex flex-col items-center justify-center gap-3 text-center animate-in fade-in duration-200">
                <AlertTriangle className="w-8 h-8 text-amber-500" />
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">出题未完成</h3>
                <p className="text-xs text-slate-500 max-w-md">{phase.message}</p>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: 'form' })}
                  className="mt-3 px-5 py-2 text-xs font-semibold rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 hover:opacity-90 transition cursor-pointer"
                >
                  返回重试
                </button>
              </div>
            )}

            {/* 状态 4：考场作答 (Answering View) */}
            {phase.kind === 'answering' && (
              <div className="flex flex-col gap-5 animate-in fade-in duration-200">
                {/* 考场顶栏 */}
                <div className="p-4 rounded-xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                      {phase.attempt.questions.length} 题测验 · {topic}
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-medium">
                      {DIFFICULTY_LABELS[difficulty]}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                      已作答 {answeredCount} / {phase.attempt.questions.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('确定放弃本次练习并返回吗？')) {
                          setPhase({ kind: 'form' });
                        }
                      }}
                      className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition cursor-pointer"
                    >
                      放弃本次
                    </button>
                  </div>
                </div>

                {/* 题目卡片列表 */}
                {phase.attempt.questions.map((q, i) => (
                  <div
                    key={q.id}
                    className="p-6 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col gap-4"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="w-6 h-6 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-bold text-xs flex items-center justify-center shrink-0">
                        {i + 1}
                      </span>
                      <div className="flex-1">
                        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                          {q.type === 'single' ? '单选题' : '判断题'}
                        </span>
                        <p className="text-sm font-semibold text-slate-850 dark:text-slate-100 leading-relaxed">
                          {q.stem}
                        </p>
                      </div>
                    </div>

                    {/* 单选题选项 */}
                    {q.type === 'single' && q.options ? (
                      <div className="flex flex-col gap-2 pt-1 pl-8">
                        {q.options.map((o) => {
                          const isPicked = choices[q.id] === o.label;
                          return (
                            <button
                              key={o.label}
                              type="button"
                              onClick={() => pickChoice(q.id, o.label)}
                              className={`flex items-start gap-3 p-3.5 rounded-xl border text-left text-xs transition-all cursor-pointer ${
                                isPicked
                                  ? 'border-indigo-600 bg-indigo-50/80 dark:bg-indigo-950/40 dark:border-indigo-500 font-medium shadow-sm'
                                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50/50 dark:hover:bg-slate-900/40'
                              }`}
                            >
                              <span
                                className={`w-5 h-5 rounded-md text-xs font-bold flex items-center justify-center shrink-0 ${
                                  isPicked
                                    ? 'bg-indigo-600 text-white'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                                }`}
                              >
                                {o.label}
                              </span>
                              <span className="flex-1 pt-0.5 text-slate-800 dark:text-slate-200 leading-relaxed">
                                {o.text}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      /* 判断题选项 */
                      <div className="flex gap-3 pl-8">
                        {[
                          ['true', '✓ 正确'],
                          ['false', '✕ 错误'],
                        ].map(([val, label]) => {
                          const isPicked = choices[q.id] === val;
                          return (
                            <button
                              key={val}
                              type="button"
                              onClick={() => pickChoice(q.id, val)}
                              className={`flex-1 py-3 px-4 rounded-xl border font-semibold text-xs text-center transition-all cursor-pointer ${
                                isPicked
                                  ? 'border-indigo-600 bg-indigo-50/80 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 shadow-sm'
                                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}

                {/* 提交作答栏 */}
                <div className="p-4 rounded-xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex items-center justify-between sticky bottom-4">
                  <span className="text-xs text-slate-500">
                    {answeredCount < phase.attempt.questions.length
                      ? `还有 ${phase.attempt.questions.length - answeredCount} 道题未作答`
                      : '已全部作答完毕，准备交卷'}
                  </span>
                  <button
                    type="button"
                    disabled={answeredCount < phase.attempt.questions.length}
                    onClick={() => void handleSubmit()}
                    className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl shadow-md shadow-indigo-600/20 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                  >
                    提交交卷
                  </button>
                </div>
              </div>
            )}

            {/* 状态 5：判卷诊断报告 (Graded View) */}
            {phase.kind === 'graded' && (
              <div className="flex flex-col gap-6 animate-in fade-in duration-200">
                {/* 成绩卡片 */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-indigo-500/10 via-emerald-500/10 to-sky-500/10 border border-emerald-500/20 dark:border-emerald-500/20 shadow-sm flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">本次测验掌握情况</span>
                      <h2 className="text-2xl font-black text-slate-900 dark:text-slate-100 tracking-tight mt-0.5">
                        掌握 {phase.summary.correct} / {phase.summary.total}
                      </h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleGenerate()}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-sm transition cursor-pointer flex items-center gap-1.5"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>再练一组</span>
                      </button>
                      {onExploreInCanvas && (
                        <button
                          type="button"
                          onClick={() => onExploreInCanvas(topic)}
                          className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:text-indigo-600 font-semibold text-xs rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition cursor-pointer flex items-center gap-1.5"
                        >
                          <Compass className="w-3.5 h-3.5" />
                          <span>在画布中深挖</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 低置信单列提示 */}
                  {phase.results.filter((r) => r.lowConfidence).length > 0 && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>
                        其中 {phase.results.filter((r) => r.lowConfidence).length} 题作答极快（≤2s），可能为碰巧猜对，暂未计入稳定掌握。
                      </span>
                    </div>
                  )}
                </div>

                {/* 逐题详细解析 */}
                <div className="flex flex-col gap-4">
                  <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    题目精讲与误区复盘
                  </h3>
                  {phase.results.map((r, i) => (
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
                          <p className="text-sm font-semibold text-slate-850 dark:text-slate-100">
                            {r.stem}
                          </p>
                        </div>
                      </div>

                      {/* 作答状态与正确答案 */}
                      <div className="pl-8 flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-3 text-xs">
                          <span
                            className={`flex items-center gap-1 font-semibold ${
                              r.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {r.isCorrect ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                            <span>你的作答：{r.type === 'single' ? r.answer : (r.answer === 'true' ? '正确' : '错误')}</span>
                          </span>

                          {!r.isCorrect && (
                            <span className="text-slate-500 font-medium">
                              标准正确答案：<span className="text-slate-800 dark:text-slate-200 font-bold">{r.type === 'single' ? r.answer : (r.answer === 'true' ? '正确' : '错误')}</span>
                            </span>
                          )}

                          {r.lowConfidence && (
                            <span className="text-[10px] text-amber-500 px-1.5 py-0.5 rounded bg-amber-500/10">
                              秒答待巩固
                            </span>
                          )}
                        </div>

                        {/* 解析文本卡片 */}
                        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          <span className="font-bold text-slate-700 dark:text-slate-200 block mb-1">💡 试题解析：</span>
                          {r.explanation}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 底部返回操作 */}
                <div className="flex items-center justify-center gap-3 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setPhase({ kind: 'form' });
                      setTopic('');
                      setChoices({});
                    }}
                    className="px-6 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 font-medium text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                  >
                    开始其他主题练习
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
