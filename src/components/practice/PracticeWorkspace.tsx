/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Spec R1/R2 — AI 练习模式独立工作台（Practice Workspace）。
 *
 * 产品定位：与「思维画布」平级的第二产品。
 * - 顶栏支持双产品一键切换（思维画布 ↔ AI 练习）
 * - 采用现代全屏工作台架构：左侧历史练习与掌握度档案 + 右侧沉浸式主舞台
 * - 状态机：出题工作室 (form) → 生成中 (loading) → 沉浸考场 (answering) → 诊断报告 (graded)
 * - 遵循文案纪律：面向用户使用「掌握情况」，不使用「正确率」或内部技术术语
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AlertTriangle,
  PanelLeftClose,
  PanelLeftOpen,
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
  QuizQuestionTypePreference,
  QuizStats,
  QuizSubmission,
} from '../../lib/quiz-store';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { QuizResultList } from './QuizResultList';
import { QuizDetailView, type CompletedDetail } from './QuizDetailView';
import { QuizPendingView, type PendingDetail } from './QuizPendingView';
import { PracticeSidebar, type MasteryStats } from './PracticeSidebar';
import { QuizFormView } from './QuizFormView';
import { QuizAnsweringView } from './QuizAnsweringView';
import {
  DEFAULT_COUNT,
  DIFFICULTY_DESCS,
  DIFFICULTY_LABELS,
  RECOMMENDED_TOPICS,
} from './constants';

export {
  DEFAULT_COUNT,
  DIFFICULTY_DESCS,
  DIFFICULTY_LABELS,
  RECOMMENDED_TOPICS,
};
export type { MasteryStats };

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

/** 逐题耗时计算（首题相对开卷时刻，其余相对上一题首答时刻，兜底 100ms） */
export function calculateDifferentialTiming(
  questions: QuizQuestion[],
  startRef: Record<string, number>,
  startedAt: number,
  now: number,
  choices: Record<string, string>,
): QuizSubmission[] {
  const stamps = questions
    .map((q) => {
      const qid = q.id;
      const stripped = qid.replace(/^q_att_/, 'q_');
      const stamp = startRef[qid] ?? startRef[stripped];
      return { qid, stamp: stamp ?? now };
    })
    .sort((a, b) => a.stamp - b.stamp);

  const byQuestion = new Map<string, number>();
  for (let i = 0; i < stamps.length; i++) {
    const prevTime = i === 0 ? startedAt : stamps[i - 1].stamp;
    const elapsed = Math.max(100, stamps[i].stamp - prevTime);
    byQuestion.set(stamps[i].qid, elapsed);
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
  initialTopic,
  initialPhase,
  initialChoices,
  initialAttemptId = null,
  onAttemptChange,
}) => {
  const [topic, setTopic] = useState(initialTopic ?? '');
  const { confirm: confirmAction, element: confirmElement } = useConfirmDialog();
  const [difficulty, setDifficulty] = useState<QuizDifficulty>('beginner');
  const [questionType, setQuestionType] = useState<QuizQuestionTypePreference>('all');
  const [count, setCount] = useState(5);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'mistakes'>('all');
  const [serverStats, setServerStats] = useState<QuizStats | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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

  const loadStats = useCallback(async () => {
    if (!userId) {
      setServerStats(null);
      return;
    }
    const res = await quizStore.fetchQuizStats();
    if (res) setServerStats(res);
  }, [userId]);

  // 账号切换 scope 绑定（首次挂载不清 phase，避免深链被 reset）
  useEffect(() => {
    const prev = prevUserIdRef.current;
    const changed = prev !== undefined && prev !== userId;
    prevUserIdRef.current = userId;

    if (userId) {
      quizStore.bindScope(scopeKeyFor(userId));
      void quizStore.refreshHistory();
      void loadStats();
    } else {
      quizStore.reset();
      setServerStats(null);
    }
    if (changed) {
      detailSeqRef.current += 1;
      setPhase({ kind: 'form' });
      setChoices({});
    }
  }, [userId, loadStats]);

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

  // 返回表单态时自动刷新历史记录与学情统计
  useEffect(() => {
    if (phase.kind === 'form' && userId) {
      void quizStore.refreshHistory();
      void loadStats();
    }
  }, [phase.kind, userId, loadStats]);

  // 如果初始带了 topic，填入
  useEffect(() => {
    if (initialTopic) {
      setTopic(initialTopic);
    }
  }, [initialTopic]);

  const handleGenerate = useCallback(async () => {
    if (!topic.trim()) return;
    setPhase({ kind: 'loading' });
    const outcome = await quizStore.generateQuiz({ topic: topic.trim(), difficulty, count, questionType });
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
  }, [topic, difficulty, count, questionType]);

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

    setSubmitting(true);
    try {
      const outcome = await quizStore.submitAnswers(attempt.attemptId, answers);
      if (!outcome.ok) {
        setPhase({ kind: 'error', message: (outcome as { error?: string }).error || '提交失败，请稍后重试' });
        return;
      }
      const graded = outcome as { results: QuizGradeResult[]; summary: { correct: number; total: number } };
      quizStore.clearDraft(attempt.attemptId);
      void loadStats();
      setPhase({
        kind: 'graded',
        attempt,
        results: graded.results,
        summary: { correct: graded.summary.correct, total: graded.summary.total },
      });
    } finally {
      setSubmitting(false);
    }
  }, [phase, choices, loadStats]);

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

  // 历史练习总计（服务端大盘为准，本地缓存作为离线/加载中兜底）
  const masteryStats = useMemo(() => {
    if (serverStats) {
      return {
        totalAttempted: serverStats.totalAttempts,
        totalCorrect: serverStats.masteredQuestions,
        totalQuestions: serverStats.totalQuestions,
        rate: Math.round(serverStats.overallMasteryRate * 100),
      };
    }
    return computeMasteryStats(historyView.items);
  }, [serverStats, historyView.items]);

  const mistakeItemsCount = useMemo(
    () => historyView.items.filter((h) => h.status === 'completed' && h.correctCount !== null && h.correctCount < h.total).length,
    [historyView.items],
  );

  const displayedHistoryItems = useMemo(
    () =>
      historyFilter === 'mistakes'
        ? historyView.items.filter((h) => h.status === 'completed' && h.correctCount !== null && h.correctCount < h.total)
        : historyView.items,
    [historyFilter, historyView.items],
  );

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
    } else {
      void loadDetail(item.attemptId);
    }
  }, [onAttemptChange, loadDetail]);

  const handleDeleteDetail = useCallback(async (attemptId: string) => {
    const ok = await confirmAction({
      title: '删除这条练习记录？',
      description: '删除后无法恢复。',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const deleted = await quizStore.removeAttempt(attemptId);
    if (deleted) {
      closeDetail();
      void loadStats();
    }
  }, [confirmAction, closeDetail, loadStats]);

  const handleRetryDetail = useCallback(async (d: CompletedDetail) => {
    closeDetail();
    setTopic(d.topic);
    setDifficulty(d.difficulty);
    setCount(d.total);
    setChoices({});
    setPhase({ kind: 'loading' });
    const outcome = await quizStore.generateQuiz({ topic: d.topic, difficulty: d.difficulty, count: d.total });
    if (!outcome.ok) {
      setPhase({ kind: 'error', message: (outcome as { error?: string }).error || '出题失败，请稍后重试' });
      return;
    }
    const attempt = (outcome as { data: QuizAttemptView }).data;
    startRef.current = {};
    setPhase({ kind: 'answering', attempt, startedAt: Date.now() });
  }, [closeDetail]);

  const handleResume = useCallback((d: PendingDetail) => {
    const attempt: QuizAttemptView = {
      attemptId: d.attemptId,
      questions: d.questions,
      review: d.review,
    };
    const draft = quizStore.loadDraft(d.attemptId);
    const restored: Record<string, string> = {};
    for (const [qid, sub] of Object.entries(draft)) {
      if (sub && typeof sub.choice === 'string') restored[qid] = sub.choice;
    }
    setTopic(d.topic);
    setDifficulty(d.difficulty);
    setCount(d.total);
    setChoices(restored);
    startRef.current = {};
    if (onAttemptChange) onAttemptChange(null);
    setPhase({ kind: 'answering', attempt, startedAt: Date.now() });
  }, [onAttemptChange]);

  const handleDeleteAttempt = useCallback(async (item: QuizHistoryItem) => {
    const ok = await confirmAction({
      title: '删除这条练习记录？',
      description: `确定删除「${item.topic}」的练习记录吗？删除后不可恢复。`,
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const deleted = await quizStore.removeAttempt(item.attemptId);
    if (deleted) {
      const k = phaseRef.current.kind;
      if (
        (k === 'replay' && phaseRef.current.detail.attemptId === item.attemptId) ||
        (k === 'pending' && phaseRef.current.detail.attemptId === item.attemptId)
      ) {
        closeDetail();
      }
      void loadStats();
    }
  }, [confirmAction, closeDetail, loadStats]);

  const handleClearHistory = useCallback(async () => {
    const ok = await confirmAction({
      title: '清空全部往期练习记录？',
      description: '将清空你在该账号下的所有练习记录，此操作不可撤销。',
      confirmLabel: '清空全部',
      tone: 'danger',
    });
    if (!ok) return;
    const cleared = await quizStore.clearHistory();
    if (cleared) {
      closeDetail();
      void loadStats();
    }
  }, [confirmAction, closeDetail, loadStats]);

  const handleLoadMore = useCallback(() => {
    void quizStore.loadMoreHistory();
  }, []);

  const currentAttemptId = useMemo(() => {
    if (phase.kind === 'replay') return phase.detail.attemptId;
    if (phase.kind === 'pending') return phase.detail.attemptId;
    if (phase.kind === 'answering' || phase.kind === 'graded') return phase.attempt.attemptId;
    return null;
  }, [phase]);

  return (
    <div className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#070b14] text-slate-850 dark:text-slate-100 font-sans transition-colors duration-200">
      {/* ================= 顶层全局导航 Header ================= */}
      <header className="h-14 bg-white/85 dark:bg-[#070b14]/90 backdrop-blur-xl border-b border-slate-200/70 dark:border-slate-800/70 px-3 sm:px-4 flex items-center justify-between z-40 shrink-0">
        <div className="flex items-center gap-2 xl:gap-3 min-w-0">
          <BrandLogo onGoToLanding={onGoToLanding} />

          <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800 hidden sm:block" />

          {/* 移动端/折叠屏侧栏开关 */}
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-850 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors cursor-pointer"
            title={sidebarCollapsed ? '展开历史侧栏' : '收起历史侧栏'}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>

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
        <PracticeSidebar
          historyView={historyView}
          historyFilter={historyFilter}
          onSetHistoryFilter={setHistoryFilter}
          masteryStats={masteryStats}
          displayedHistoryItems={displayedHistoryItems}
          mistakeItemsCount={mistakeItemsCount}
          currentAttemptId={currentAttemptId}
          onStartNew={() => {
            setTopic('');
            setPhase({ kind: 'form' });
            setChoices({});
          }}
          onStartNewWithTopic={handleStartNewWithTopic}
          onOpenDetail={handleOpenDetail}
          onDeleteAttempt={(item) => void handleDeleteAttempt(item)}
          onClearHistory={() => void handleClearHistory()}
          onLoadMore={handleLoadMore}
          isCollapsed={sidebarCollapsed}
        />

        {/* 右侧主舞台：出题工作室 / 考场 / 判卷诊断报告 */}
        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-12 flex justify-center bg-slate-50/50 dark:bg-[#070b14]/50">
          <div className="w-full max-w-3xl flex flex-col gap-6" data-testid="quiz-panel">
            {/* 状态 1：出题工作室 (Form View) */}
            {phase.kind === 'form' && (
              <QuizFormView
                topic={topic}
                onTopicChange={setTopic}
                difficulty={difficulty}
                onDifficultyChange={setDifficulty}
                count={count}
                onCountChange={setCount}
                questionType={questionType}
                onQuestionTypeChange={setQuestionType}
                serverStats={serverStats}
                onGenerate={() => void handleGenerate()}
              />
            )}

            {/* 状态 2：生成中 (Loading View) */}
            {phase.kind === 'loading' && (
              <div className="p-12 rounded-2xl bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-col items-center justify-center gap-4 text-center animate-in fade-in duration-200">
                <div className="relative">
                  <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shadow-sm">
                    <Spinner size="lg" />
                  </div>
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-850 dark:text-slate-100">
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
                <h3 className="text-sm font-bold text-slate-850 dark:text-slate-100">出题未完成</h3>
                <p className="text-xs text-slate-500 max-w-md">{phase.message}</p>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: 'form' })}
                  className="mt-3 px-5 py-2 text-xs font-semibold rounded-xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 hover:opacity-90 transition cursor-pointer"
                >
                  返回重试
                </button>
              </div>
            )}

            {/* 状态 4：考场作答 (Answering View) */}
            {phase.kind === 'answering' && (
              <QuizAnsweringView
                attempt={phase.attempt}
                topic={topic}
                difficulty={difficulty}
                choices={choices}
                onPickChoice={pickChoice}
                onSubmit={() => void handleSubmit()}
                onAbandon={async () => {
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
                submitting={submitting}
              />
            )}

            {/* 详情加载中 */}
            {phase.kind === 'detail-loading' && (
              <div className="p-16 flex flex-col items-center justify-center gap-3">
                <Spinner size="lg" />
                <span className="text-xs text-slate-500">正在载入练习详情…</span>
              </div>
            )}

            {/* 详情加载错误 */}
            {phase.kind === 'detail-error' && (
              <div className="p-8 rounded-2xl bg-white dark:bg-[#0c1222] border border-rose-200 dark:border-rose-900/60 shadow-sm flex flex-col items-center justify-center gap-3 text-center animate-in fade-in duration-200">
                <AlertTriangle className="w-8 h-8 text-amber-500" />
                <h3 className="text-sm font-bold text-slate-850 dark:text-slate-100">
                  {phase.status === 401 ? '请先登录' : phase.status === 404 ? '记录不存在' : '详情加载失败'}
                </h3>
                <p className="text-xs text-slate-500 max-w-md">{phase.message}</p>
                <div className="flex items-center gap-2 mt-2">
                  {phase.status === 401 ? (
                    <button
                      type="button"
                      onClick={() => openAuthModal('signin')}
                      className="px-5 py-2 text-xs font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition cursor-pointer"
                    >
                      登录后查看
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void loadDetail(phase.attemptId)}
                      className="px-5 py-2 text-xs font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition cursor-pointer"
                    >
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={closeDetail}
                    className="px-5 py-2 text-xs font-semibold rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
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
                onDelete={() => void handleDeleteDetail(phase.detail.attemptId)}
                onRetry={() => void handleRetryDetail(phase.detail)}
                onExplore={onExploreInCanvas}
              />
            )}

            {/* 状态 7：历史详情（未交卷，可续答） */}
            {phase.kind === 'pending' && (
              <QuizPendingView
                detail={phase.detail}
                onResume={() => handleResume(phase.detail)}
                onDelete={() => void handleDeleteDetail(phase.detail.attemptId)}
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
