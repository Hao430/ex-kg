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
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  ArrowRight,
  RotateCcw,
  Plus,
  BookOpen,
  ChevronRight,
  History,
  TrendingUp,
  Check,
  Flame,
  Lightbulb,
  Eye,
  Trash2,
  Loader2,
} from 'lucide-react';
import * as quizStore from '../../lib/quiz-store';
import type { AuthUser } from '../../types';
import {
  BrandLogo,
  ProductSwitchPill,
  VipBadge,
  ThemeToggleButton,
  UserDropdown,
} from '../ui/topbar';
import { Spinner } from '../ui/base/Spinner';
import { scopeKeyFor } from '../../lib/board-scope';
import type {
  QuizAttemptView,
  QuizDifficulty,
  QuizGradeResult,
  QuizHistoryItem,
  QuizQuestion,
  QuizSubmission,
} from '../../lib/quiz-store';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { Tooltip } from '../ui/Tooltip';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { QuizResultList } from './QuizResultList';
import { QuizDetailView, type CompletedDetail } from './QuizDetailView';
import { QuizPendingView, type PendingDetail } from './QuizPendingView';

export const DIFFICULTY_LABELS: Record<QuizDifficulty, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '困难',
};

export const DIFFICULTY_DESCS: Record<QuizDifficulty, { title: string; desc: string; detail: string }> = {
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
export const DEFAULT_COUNT: Record<QuizDifficulty, number> = {
  beginner: 5,
  intermediate: 5,
  advanced: 3,
};

/** 推荐练习主题 Pills */
export const RECOMMENDED_TOPICS = [
  'Transformer 多头注意力机制',
  'TCP 三次握手与状态流转',
  '高中生物光合作用光反应',
  '微积分基本定理与几何意义',
  'Raft 分布式共识机制',
  '快速排序与时间复杂度分析',
  '量子计算叠加态与量子纠缠',
  '边际效用递减与机会成本',
];

export interface PracticeWorkspaceProps {
  userId: string | null;
  user: AuthUser | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  activeProduct: 'canvas' | 'practice';
  onSwitchProduct: (product: 'canvas' | 'practice') => void;
  onGoToLanding: () => void;
  onExploreInCanvas?: (topic: string) => void;
  initialTopic?: string;
  initialPhase?: Phase;
  initialChoices?: Record<string, string>;
  /** 深链 /practice/:attemptId；由 App 从 URL 解析后传入 */
  initialAttemptId?: string | null;
  /** 打开/关闭详情时通知父级更新 URL；未提供时组件自行加载（RTL/嵌入场景） */
  onAttemptChange?: (attemptId: string | null) => void;
}

export type Phase =
  | { kind: 'form' }
  | { kind: 'loading' }
  | { kind: 'answering'; attempt: QuizAttemptView; startedAt: number }
  | { kind: 'graded'; attempt: QuizAttemptView; results: QuizGradeResult[]; summary: { correct: number; total: number } }
  | { kind: 'detail-loading'; attemptId: string }
  | { kind: 'detail-error'; message: string; status: 401 | 404 | 'other'; attemptId: string }
  | { kind: 'replay'; detail: CompletedDetail }
  | { kind: 'pending'; detail: PendingDetail }
  | { kind: 'error'; message: string };

export interface MasteryStats {
  totalAttempted: number;
  totalCorrect: number;
  totalQuestions: number;
  rate: number;
}

/** 逐题耗时计算（首题相对开卷时刻，其余相对上一题首答时刻，兜底 100ms） */
export function calculateDifferentialTiming(
  questions: QuizQuestion[],
  startRef: Record<string, number>,
  startedAt: number,
  now: number,
  choices: Record<string, string>,
): QuizSubmission[] {
  const stamps = questions
    .map((q) => startRef[q.id])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  const byQuestion = new Map<string, number>();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const stamp = startRef[q.id];
    if (typeof stamp !== 'number') {
      byQuestion.set(q.id, now - startedAt);
      continue;
    }
    let prev = startedAt;
    for (const s of stamps) {
      if (s < stamp) prev = s;
    }
    byQuestion.set(q.id, stamp - prev);
  }
  return questions.map((q) => ({
    questionId: q.id,
    choice: choices[q.id] ?? choices[q.id.replace(/^q_att_/, 'q_')] ?? '',
    elapsedMs: Math.max(100, byQuestion.get(q.id) ?? 1000),
  }));
}

/** 历史练习掌握度大盘统计 */
export function computeMasteryStats(items: QuizHistoryItem[]): MasteryStats {
  const completed = items.filter((h) => h.status === 'completed' && h.correctCount !== null);
  const totalAttempted = items.length;
  const totalCorrect = completed.reduce((acc, h) => acc + (h.correctCount || 0), 0);
  const totalQuestions = completed.reduce((acc, h) => acc + h.total, 0);
  const rate = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
  return { totalAttempted, totalCorrect, totalQuestions, rate };
}

export function normalizeChoices(
  raw: Record<string, string> | undefined,
  questions?: QuizQuestion[],
): Record<string, string> {
  if (!raw) return {};
  const res: Record<string, string> = { ...raw };
  if (questions) {
    for (const q of questions) {
      const stripped = q.id.replace(/^q_att_/, 'q_');
      if (res[stripped] !== undefined && res[q.id] === undefined) {
        res[q.id] = res[stripped];
      }
      if (res[q.id] !== undefined && res[stripped] === undefined) {
        res[stripped] = res[q.id];
      }
    }
  }
  return res;
}

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
  initialPhase,
  initialChoices,
  initialAttemptId = null,
  onAttemptChange,
}) => {
  const [topic, setTopic] = useState(initialTopic);
  const { confirm: confirmAction, element: confirmElement } = useConfirmDialog();
  const [difficulty, setDifficulty] = useState<QuizDifficulty>('beginner');
  const [count, setCount] = useState(5);
  const [phase, setPhase] = useState<Phase>(initialPhase ?? { kind: 'form' });
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    normalizeChoices(
      initialChoices,
      initialPhase?.kind === 'answering' ? initialPhase.attempt.questions : undefined,
    ),
  );
  const historyView = useSyncExternalStore(
    quizStore.subscribe,
    quizStore.getHistoryView,
    quizStore.getHistoryView,
  );
  const startRef = useRef<Record<string, number>>({});
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const { isVip, loading: authLoading } = useAuth();
  const { openRechargeModal, openAuthModal } = useModal();

  /** 详情请求序号：连点不同记录时只采纳最后一次回包 */
  const detailSeqRef = useRef(0);
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  const loadDetail = useCallback(async (attemptId: string) => {
    const seq = ++detailSeqRef.current;
    setPhase({ kind: 'detail-loading', attemptId });
    const outcome = await quizStore.fetchAttemptDetailOutcome(attemptId);
    if (seq !== detailSeqRef.current) return;

    if (outcome.ok === false) {
      setPhase({ kind: 'detail-error', message: outcome.error, status: outcome.status, attemptId });
      return;
    }
    const detail = outcome.detail;
    if (detail.status === 'completed' && detail.results && detail.summary) {
      setPhase({ kind: 'replay', detail: detail as CompletedDetail });
      return;
    }
    if (detail.status === 'in_progress' && detail.questions) {
      setPhase({ kind: 'pending', detail: detail as PendingDetail });
      return;
    }
    setPhase({
      kind: 'detail-error',
      message: '详情数据不完整，请刷新重试',
      status: 'other',
      attemptId,
    });
  }, []);

  const closeDetail = useCallback(() => {
    detailSeqRef.current += 1;
    if (onAttemptChange) onAttemptChange(null);
    setPhase({ kind: 'form' });
    setTopic('');
    setChoices({});
  }, [onAttemptChange]);

  // 账号切换 scope 绑定（首次挂载不清 phase，避免深链被 reset）
  useEffect(() => {
    const prev = prevUserIdRef.current;
    const changed = prev !== undefined && prev !== userId;
    prevUserIdRef.current = userId;

    if (userId) {
      quizStore.bindScope(scopeKeyFor(userId));
      void quizStore.refreshHistory();
    } else {
      quizStore.reset();
    }
    if (changed) {
      detailSeqRef.current += 1;
      setPhase({ kind: 'form' });
      setChoices({});
    }
  }, [userId]);

  // 深链：initialAttemptId 变化时加载详情；清空时只关闭详情态
  useEffect(() => {
    if (authLoading) return;
    if (!initialAttemptId) {
      const k = phaseRef.current.kind;
      if (k === 'replay' || k === 'pending' || k === 'detail-loading' || k === 'detail-error') {
        detailSeqRef.current += 1;
        setPhase({ kind: 'form' });
        setChoices({});
      }
      return;
    }
    if (!userId) {
      setPhase({
        kind: 'detail-error',
        message: '请先登录后查看练习记录',
        status: 401,
        attemptId: initialAttemptId,
      });
      return;
    }
    void loadDetail(initialAttemptId);
  }, [initialAttemptId, userId, authLoading, loadDetail]);

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

    const answers = calculateDifferentialTiming(
      attempt.questions,
      startRef.current,
      phase.startedAt,
      now,
      choices,
    );

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
      const stripped = questionId.replace(/^q_att_/, 'q_');
      const next = { ...prev, [questionId]: choice, [stripped]: choice };
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
    () =>
      phase.kind === 'answering'
        ? phase.attempt.questions.filter(
            (q) => choices[q.id] || choices[q.id.replace(/^q_att_/, 'q_')],
          ).length
        : 0,
    [phase, choices],
  );

  // 历史练习总计
  const masteryStats = useMemo(() => computeMasteryStats(historyView.items), [historyView.items]);

  const handleStartNewWithTopic = (t: string, d?: QuizDifficulty) => {
    if (onAttemptChange) onAttemptChange(null);
    setTopic(t);
    if (d) {
      setDifficulty(d);
      setCount(DEFAULT_COUNT[d]);
    }
    setChoices({});
    setPhase({ kind: 'form' });
  };

  /** 打开详情：有 URL 回调时交给 App 推路径，由深链 effect 统一加载；否则本地加载 */
  const handleOpenDetail = useCallback((item: QuizHistoryItem) => {
    detailSeqRef.current += 1;
    if (onAttemptChange) {
      onAttemptChange(item.attemptId);
      return;
    }
    void loadDetail(item.attemptId);
  }, [onAttemptChange, loadDetail]);

  const handleDeleteAttempt = useCallback(async (item: QuizHistoryItem) => {
    const ok = await confirmAction({
      title: '删除这条练习记录？',
      description: '删除后无法恢复，掌握情况统计会同步减少。',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!ok) return;

    const wasCurrent =
      (phase.kind === 'replay' && phase.detail.attemptId === item.attemptId) ||
      (phase.kind === 'pending' && phase.detail.attemptId === item.attemptId) ||
      (phase.kind === 'answering' && phase.attempt.attemptId === item.attemptId) ||
      (phase.kind === 'graded' && phase.attempt.attemptId === item.attemptId);
    const removed = await quizStore.removeAttemptById(item.attemptId);
    if (removed && wasCurrent) closeDetail();
  }, [confirmAction, phase, closeDetail]);

  /** 详情页删除：直接按 id 删（记录可能不在已加载的历史页里） */
  const handleDeleteDetail = useCallback(async () => {
    if (phase.kind !== 'replay' && phase.kind !== 'pending') return;
    const id = phase.detail.attemptId;
    const ok = await confirmAction({
      title: '删除这条练习记录？',
      description: '删除后无法恢复，掌握情况统计会同步减少。',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const removed = await quizStore.removeAttemptById(id);
    if (removed) closeDetail();
  }, [confirmAction, phase, closeDetail]);

  const handleResume = useCallback(() => {
    if (phase.kind !== 'pending') return;
    const detail = phase.detail;
    const attempt: QuizAttemptView = {
      attemptId: detail.attemptId,
      questions: detail.questions,
      review: detail.review,
    };
    const draft = quizStore.loadDraft(detail.attemptId);
    const restored: Record<string, string> = {};
    for (const [qid, sub] of Object.entries(draft)) {
      if (sub && typeof sub.choice === 'string') restored[qid] = sub.choice;
    }
    setChoices(restored);
    startRef.current = {};
    setPhase({ kind: 'answering', attempt, startedAt: Date.now() });
  }, [phase]);

  const handleRetryDetail = useCallback(() => {
    if (phase.kind !== 'replay' && phase.kind !== 'pending') return;
    handleStartNewWithTopic(phase.detail.topic, phase.detail.difficulty);
  }, [phase]);

  const handleClearHistory = useCallback(async () => {
    const ok = await confirmAction({
      title: '清空全部练习记录？',
      description: '所有历史记录与统计将永久删除，且无法恢复。',
      confirmLabel: '清空',
      tone: 'danger',
    });
    if (!ok) return;
    const cleared = await quizStore.clearHistory();
    if (cleared) closeDetail();
  }, [confirmAction, closeDetail]);

  const handleLoadMore = useCallback(() => {
    void quizStore.loadMoreHistory();
  }, []);

  return (
    <div className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#070b14] text-slate-850 dark:text-slate-100 font-sans transition-colors duration-200">
      {/* ================= 顶层全局导航 Header ================= */}
      <header className="h-14 bg-white/80 dark:bg-[#070b14]/85 backdrop-blur-xl border-b border-slate-200/70 dark:border-slate-800/70 px-3 sm:px-4 flex items-center justify-between z-40 shrink-0">
        <div className="flex items-center gap-2 xl:gap-3 min-w-0">
          <BrandLogo onGoToLanding={onGoToLanding} />

          <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 hidden sm:block" />

          {/* ================= 双产品切换胶囊（共享组件） ================= */}
          <ProductSwitchPill activeProduct={activeProduct} onSwitchProduct={onSwitchProduct} />
        </div>

        {/* 右侧控制区（VIP / 主题 / 用户中心均为共享组件；UserDropdown 带安全退出登录） */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {user && (
            <VipBadge
              isVip={isVip}
              sourceVip="VIP 会员特权管理"
              sourceUpgrade="升级 VIP 会员解锁全部特权"
              onOpen={openRechargeModal}
            />
          )}
          <ThemeToggleButton isDark={theme === 'dark'} onToggle={onToggleTheme} />
          <UserDropdown onGoToLanding={onGoToLanding} />
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
              <span className="text-xxs text-slate-400">{masteryStats.totalAttempted} 场测验</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2.5 rounded-lg bg-white dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60">
                <div className="text-xxs text-slate-500 dark:text-slate-400">已掌握题目</div>
                <div className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-0.5">
                  {masteryStats.totalCorrect}
                  <span className="text-xs font-normal text-slate-400"> / {masteryStats.totalQuestions}</span>
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-white dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60">
                <div className="text-xxs text-slate-500 dark:text-slate-400">总体掌握率</div>
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
              <div className="flex items-center gap-2">
                {historyView.offline && <span className="text-xxs text-amber-500">离线缓存</span>}
                {historyView.items.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleClearHistory()}
                    className="text-xxs text-slate-400 hover:text-rose-500 transition-colors cursor-pointer"
                  >
                    清空
                  </button>
                )}
              </div>
            </div>
            {historyView.historyError && (
              <div className="px-2 text-xxs text-rose-500">{historyView.historyError}</div>
            )}

            {historyView.items.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400 dark:text-slate-500 space-y-2">
                <BookOpen className="w-8 h-8 mx-auto opacity-30" />
                <p>暂无往期练习记录</p>
                <p className="text-xxs text-slate-400">输入主题开始第一次测验吧</p>
              </div>
            ) : (
              <>
                {historyView.items.map((item) => {
                  const isSelected =
                    (phase.kind === 'replay' && phase.detail.attemptId === item.attemptId) ||
                    (phase.kind === 'pending' && phase.detail.attemptId === item.attemptId) ||
                    ((phase.kind === 'answering' || phase.kind === 'graded') &&
                      phase.attempt.attemptId === item.attemptId);
                  return (
                    <div
                      key={item.attemptId}
                      className={`w-full p-3 rounded-xl border transition-all group ${
                        isSelected
                          ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700/80 shadow-sm'
                          : 'bg-white dark:bg-slate-900/60 border-slate-200/70 dark:border-slate-800/70 hover:border-indigo-200 dark:hover:border-slate-700 hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => handleStartNewWithTopic(item.topic, item.difficulty)}
                          className="flex-1 min-w-0 text-left cursor-pointer"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 line-clamp-1 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                              {item.topic}
                            </span>
                            <span className="text-xxs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">
                              {DIFFICULTY_LABELS[item.difficulty]}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xxs text-slate-400 mt-2">
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

                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            title="查看详情"
                            onClick={() => handleOpenDetail(item)}
                            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 rounded-lg transition-colors cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title="删除记录"
                            onClick={() => void handleDeleteAttempt(item)}
                            className="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
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
                    onClick={handleLoadMore}
                    disabled={historyView.loadingMore}
                    className="w-full mt-2 py-2 rounded-xl border border-slate-200 dark:border-slate-800 text-xxs text-slate-500 hover:text-indigo-600 hover:border-indigo-200 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-1.5"
                  >
                    {historyView.loadingMore ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    {historyView.loadingMore ? '加载中…' : '加载更多'}
                  </button>
                )}
              </>
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
                      <span className="text-xxs font-normal text-slate-400">{topic.length}/200</span>
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={topic}
                        maxLength={200}
                        onChange={(e) => setTopic(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && topic.trim()) void handleGenerate(); }}
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
                    <span className="text-xxs font-medium text-slate-400 flex items-center gap-1">
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
                              <p className="text-xxs text-slate-500 dark:text-slate-400 leading-relaxed">
                                {info.desc}
                              </p>
                            </div>
                            <span className="text-xxs text-indigo-600/80 dark:text-indigo-400/80 mt-2 font-medium">
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
                      <span className="text-xxs text-slate-400">单选题与判断题组合呈现</span>
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
                    <Spinner size="lg" />
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
              <div className="p-8 rounded-2xl bg-white dark:bg-[#0c1222] border border-rose-200 dark:border-rose-900/60 shadow-sm flex flex-col items-center justify-center gap-3 text-center animate-in fade-in duration-200">
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
                    <span className="text-xxs px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-medium">
                      {DIFFICULTY_LABELS[difficulty]}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                      已作答 {answeredCount} / {phase.attempt.questions.length}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: '确定放弃本次练习并返回吗？',
                            description: '已作答的内容不会提交。',
                            confirmLabel: '放弃本次',
                            tone: 'warning',
                          })
                        ) {
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
                        <span className="text-xxs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
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
                          const pickedVal = choices[q.id] ?? choices[q.id.replace(/^q_att_/, 'q_')];
                          const isPicked = pickedVal === o.label;
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
                          const pickedVal = choices[q.id] ?? choices[q.id.replace(/^q_att_/, 'q_')];
                          const isPicked = pickedVal === val;
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

            {/* 详情加载中 */}
            {phase.kind === 'detail-loading' && (
              <div className="p-12 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col items-center justify-center gap-4 text-center animate-in fade-in duration-200">
                <Spinner size="lg" />
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">正在加载练习详情…</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">正在读取题目、作答与解析</p>
                </div>
              </div>
            )}

            {/* 详情错误 / 未登录 / 不存在 */}
            {phase.kind === 'detail-error' && (
              <div className="p-8 rounded-2xl bg-white dark:bg-[#0c1222] border border-rose-200 dark:border-rose-900/60 shadow-sm flex flex-col items-center justify-center gap-3 text-center animate-in fade-in duration-200">
                <AlertTriangle className="w-8 h-8 text-amber-500" />
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  {phase.status === 401 ? '请先登录' : phase.status === 404 ? '记录不存在' : '详情加载失败'}
                </h3>
                <p className="text-xs text-slate-500 max-w-md">{phase.message}</p>
                <div className="mt-3 flex items-center gap-2">
                  {phase.status === 401 ? (
                    <button
                      type="button"
                      onClick={() => openAuthModal('signin')}
                      className="px-5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition cursor-pointer"
                    >
                      登录后查看
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void loadDetail(phase.attemptId)}
                      className="px-5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition cursor-pointer"
                    >
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={closeDetail}
                    className="px-5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                  >
                    返回列表
                  </button>
                </div>
              </div>
            )}

            {/* 状态 5：判卷诊断报告 (Graded View) */}
            {phase.kind === 'graded' && (
              <QuizResultList
                results={phase.results}
                summary={phase.summary}
                topic={topic}
                onRetry={() => {
                  closeDetail();
                  void handleGenerate();
                }}
                onExplore={onExploreInCanvas}
                onBack={closeDetail}
              />
            )}

            {/* 状态 6：历史详情（已交卷） */}
            {phase.kind === 'replay' && (
              <QuizDetailView
                detail={phase.detail}
                onBack={closeDetail}
                onDelete={handleDeleteDetail}
                onRetry={handleRetryDetail}
                onExplore={onExploreInCanvas}
              />
            )}

            {/* 状态 7：历史详情（未交卷，可续答） */}
            {phase.kind === 'pending' && (
              <QuizPendingView
                detail={phase.detail}
                onResume={handleResume}
                onDelete={handleDeleteDetail}
                onBack={closeDetail}
                onExplore={onExploreInCanvas}
              />
            )}

          </div>
        </main>
      </div>

      {/* Promise 化确认框（放弃本次练习等） */}
      {confirmElement}
    </div>
  );
};
