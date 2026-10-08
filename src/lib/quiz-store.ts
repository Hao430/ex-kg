/**
 * Spec R1 — AI 练习本地状态（服务端为准 + 按 scope 缓存）。
 *
 * ⚠️ **刻意不进 board-store / sync-queue / storage**：那三条链路是「画布内容」的
 * 生命周期（节点的生死绑定 canvas、载入以服务端为准、会丢未上传内容）。练习记录
 * 是**跨画板的用户资产**，走那套会互相干扰。
 *
 * - 服务端 `/api/quiz/*` 为权威，本地缓存只作离线可见与快速首屏
 * - 依赖约定：只依赖 board-scope，避免与 storage 成环（照 folder-store）
 * - 游客不显示入口，故本模块不处理游客态
 */
import * as scope from './board-scope';

export type QuizDifficulty = 'beginner' | 'intermediate' | 'advanced';
export type QuizQuestionType = 'single' | 'true_false';

export interface QuizOption {
  label: string;
  text: string;
}

/** ① 出题响应中的题目（**不含**答案与解析，这是架构约束） */
export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  stem: string;
  options: QuizOption[] | null;
}

export interface QuizAttemptView {
  attemptId: string;
  questions: QuizQuestion[];
  /** 自审摘要：学科判定 / 难度匹配 / 误区设计（让用户知道这套题的来历） */
  review: Record<string, unknown>;
}

/** 列表项（同样不含答案） */
export interface QuizHistoryItem {
  attemptId: string;
  topic: string;
  difficulty: QuizDifficulty;
  status: 'in_progress' | 'completed';
  total: number;
  correctCount: number | null;
  createdAt: string;
  completedAt: string | null;
  review: Record<string, unknown>;
}

/** ② 判卷响应中的单题结果 */
export interface QuizGradeResult {
  questionId: string;
  type: QuizQuestionType;
  stem: string;
  isCorrect: boolean;
  answer: string;
  explanation: string;
  knowledgePoint: string;
  elapsedMs: number;
  lowConfidence: boolean;
}

export interface QuizGradeSummary {
  correct: number;
  total: number;
  accuracy: number;
  status: 'completed';
}

export interface QuizSubmission {
  questionId: string;
  choice: string;
  elapsedMs: number;
}

export type QuizGenerateOutcome =
  | { ok: true; data: QuizAttemptView }
  | { ok: false; error: string };

export type QuizSubmitOutcome =
  | { ok: true; results: QuizGradeResult[]; summary: QuizGradeSummary }
  | { ok: false; error: string; code?: string };

export interface QuizHistoryView {
  items: QuizHistoryItem[];
  loaded: boolean;
  offline: boolean;
}

let history: QuizHistoryItem[] = [];
let historyLoaded = false;
let historyOffline = false;
let boundScope: scope.ScopeKey | null = null;
let view: QuizHistoryView = { items: [], loaded: false, offline: false };
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.error('quiz-store listener error:', e);
    }
  }
}

function rebuild(): void {
  view = { items: history, loaded: historyLoaded, offline: historyOffline };
  notify();
}

function persist(): void {
  try {
    localStorage.setItem(scope.quizCacheKey(boundScope ?? undefined), JSON.stringify(history));
  } catch {
    // 存储不可用时静默降级（练习记录在服务端，本地缓存只是优化）
  }
}

function hydrateLocal(key: scope.ScopeKey): void {
  try {
    const raw = localStorage.getItem(scope.quizCacheKey(key));
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) history = parsed as QuizHistoryItem[];
  } catch {
    // 缓存坏了就用空视图，不阻断
  }
}

/** 登出/切换账号时重置视图（避免跨账号看到他人练习记录） */
export function reset(): void {
  history = [];
  historyLoaded = false;
  historyOffline = false;
  boundScope = null;
  rebuild();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getHistoryView(): QuizHistoryView {
  return view;
}

/** 绑定账号 scope：换账号即重置并从本地缓存预热（离线也能看到历史） */
export function bindScope(scopeKey: scope.ScopeKey): void {
  if (boundScope === scopeKey) return;
  boundScope = scopeKey;
  history = [];
  historyLoaded = false;
  historyOffline = false;
  hydrateLocal(scopeKey);
  rebuild();
}

/** 写入或更新一条历史项（本地先行，服务端历史刷新后会覆盖） */
function upsertLocalItem(item: QuizHistoryItem): void {
  const idx = history.findIndex((h) => h.attemptId === item.attemptId);
  if (idx >= 0) history = history.map((h, i) => (i === idx ? item : h));
  else history = [item, ...history];
}

/** 出题：① 只拿题干与选项 */
export async function generateQuiz(input: {
  topic: string;
  difficulty: QuizDifficulty;
  count: number;
}): Promise<QuizGenerateOutcome> {
  try {
    const res = await fetch('/api/quiz/attempts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      historyOffline = true;
      rebuild();
      return { ok: false, error: body?.error || '出题失败，请稍后重试' };
    }
    const data = await res.json() as QuizAttemptView;
    historyOffline = false;
    upsertLocalItem({
      attemptId: data.attemptId,
      topic: input.topic,
      difficulty: input.difficulty,
      status: 'in_progress',
      total: data.questions.length,
      correctCount: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      review: data.review || {},
    });
    persist();
    rebuild();
    return { ok: true, data };
  } catch {
    historyOffline = true;
    rebuild();
    return { ok: false, error: '网络异常，出题未完成' };
  }
}

/** 交卷：② 返回正确答案与解析 */
export async function submitAnswers(
  attemptId: string,
  answers: QuizSubmission[],
): Promise<QuizSubmitOutcome> {
  try {
    const res = await fetch(`/api/quiz/attempts/${attemptId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok) {
      return {
        ok: false,
        error: body?.error || '提交失败，请稍后重试',
        code: body?.code,
      };
    }
    // 本地历史同步为已完成（权威仍在服务端，此处仅免得等一次 round-trip）
    const existing = history.find((h) => h.attemptId === attemptId);
    if (existing) {
      upsertLocalItem({
        ...existing,
        status: 'completed',
        correctCount: body.summary.correct,
        completedAt: new Date().toISOString(),
      });
    }
    persist();
    rebuild();
    return { ok: true, results: body.results as QuizGradeResult[], summary: body.summary };
  } catch {
    return { ok: false, error: '网络异常，提交未完成' };
  }
}

/** 历史列表：服务端为准，失败回落本地缓存（离线可见） */
export async function refreshHistory(): Promise<void> {
  try {
    const res = await fetch('/api/quiz/attempts');
    if (!res.ok) throw new Error('history failed');
    const body = await res.json() as { attempts: QuizHistoryItem[] };
    history = Array.isArray(body.attempts) ? body.attempts : [];
    historyLoaded = true;
    historyOffline = false;
    persist();
  } catch {
    historyOffline = true;
    // 本地缓存保留：history 数组不动，只更新 offline 标记
  }
  rebuild();
}

/** 清除已提交的作答草稿（照 chat-draft 先例：成功后必须清） */
export function clearDraft(attemptId: string): void {
  try {
    localStorage.removeItem(`${scope.quizCacheKey(boundScope ?? undefined)}:draft:${attemptId}`);
  } catch {
    // 忽略
  }
}

/** 暂存未提交草稿（切面板/刷新不丢） */
export function saveDraft(attemptId: string, answers: Record<string, QuizSubmission>): void {
  try {
    localStorage.setItem(
      `${scope.quizCacheKey(boundScope ?? undefined)}:draft:${attemptId}`,
      JSON.stringify(answers),
    );
  } catch {
    // 忽略
  }
}

export function loadDraft(attemptId: string): Partial<Record<string, QuizSubmission>> {
  try {
    const raw = localStorage.getItem(`${scope.quizCacheKey(boundScope ?? undefined)}:draft:${attemptId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
