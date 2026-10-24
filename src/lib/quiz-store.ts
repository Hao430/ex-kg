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
 * - 订阅/视图/作用域骨架由 store-factory 提供（2026-10 反抽）
 */
import * as scope from './board-scope';
import { createScopedStore } from './store-factory';
import { extractErrorMessage } from './api';

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

interface QuizState {
  history: QuizHistoryItem[];
  loaded: boolean;
  offline: boolean;
}

const emptyState = (): QuizState => ({ history: [], loaded: false, offline: false });

/** 缓存 key 与 JSON 格式保持不变（旧缓存必须还能读） */
const store = createScopedStore<QuizState, QuizHistoryView>({
  name: 'quiz-store',
  initialState: emptyState,
  buildView: (s) => ({ items: s.history, loaded: s.loaded, offline: s.offline }),
  /** 绑定账号 scope：换账号即重置并从本地缓存预热（离线也能看到历史） */
  onScopeBind: (key) => {
    const next = emptyState();
    try {
      const raw = localStorage.getItem(scope.quizCacheKey(key));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) next.history = parsed as QuizHistoryItem[];
      }
    } catch {
      // 缓存坏了就用空视图，不阻断
    }
    return next;
  },
  writeCache: (s, key) => {
    try {
      localStorage.setItem(scope.quizCacheKey(key ?? undefined), JSON.stringify(s.history));
    } catch {
      // 存储不可用时静默降级（练习记录在服务端，本地缓存只是优化）
    }
  },
});

/** 写入或更新一条历史项（本地先行，服务端历史刷新后会覆盖） */
function upsertLocalItem(item: QuizHistoryItem): void {
  const history = store.getState().history;
  const idx = history.findIndex((h) => h.attemptId === item.attemptId);
  const next =
    idx >= 0 ? history.map((h, i) => (i === idx ? item : h)) : [item, ...history];
  store.setState({ ...store.getState(), history: next });
}

/** 登出/切换账号时重置视图（避免跨账号看到他人练习记录） */
export function reset(): void {
  store.setState(emptyState());
  store.clearScope();
}

export function subscribe(cb: () => void): () => void {
  return store.subscribe(cb);
}

export function getHistoryView(): QuizHistoryView {
  return store.getView();
}

/** 绑定账号 scope（同 key 幂等） */
export function bindScope(scopeKey: scope.ScopeKey): void {
  store.bindScope(scopeKey);
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
      store.setState({ ...store.getState(), offline: true });
      return { ok: false, error: await extractErrorMessage(res, '出题失败，请稍后重试') };
    }
    const data = await res.json() as QuizAttemptView;
    store.setState({ ...store.getState(), offline: false });
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
    store.persistNow();
    return { ok: true, data };
  } catch {
    store.setState({ ...store.getState(), offline: true });
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
      // body 还要取 code，不能交给 extractErrorMessage 二次消费响应体
      return {
        ok: false,
        error: body?.error || '提交失败，请稍后重试',
        code: body?.code,
      };
    }
    // 本地历史同步为已完成（权威仍在服务端，此处仅免得等一次 round-trip）
    const existing = store.getState().history.find((h) => h.attemptId === attemptId);
    if (existing) {
      upsertLocalItem({
        ...existing,
        status: 'completed',
        correctCount: body.summary.correct,
        completedAt: new Date().toISOString(),
      });
    }
    store.persistNow();
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
    store.setState({
      ...store.getState(),
      history: Array.isArray(body.attempts) ? body.attempts : [],
      loaded: true,
      offline: false,
    });
    store.persistNow();
  } catch {
    // 本地缓存保留：history 数组不动，只更新 offline 标记
    store.setState({ ...store.getState(), offline: true });
  }
}

/** 清除已提交的作答草稿（照 chat-draft 先例：成功后必须清） */
export function clearDraft(attemptId: string): void {
  try {
    localStorage.removeItem(`${scope.quizCacheKey(store.getBoundScope() ?? undefined)}:draft:${attemptId}`);
  } catch {
    // 忽略
  }
}

/** 暂存未提交草稿（切面板/刷新不丢） */
export function saveDraft(attemptId: string, answers: Record<string, QuizSubmission>): void {
  try {
    localStorage.setItem(
      `${scope.quizCacheKey(store.getBoundScope() ?? undefined)}:draft:${attemptId}`,
      JSON.stringify(answers),
    );
  } catch {
    // 忽略
  }
}

export function loadDraft(attemptId: string): Partial<Record<string, QuizSubmission>> {
  try {
    const raw = localStorage.getItem(`${scope.quizCacheKey(store.getBoundScope() ?? undefined)}:draft:${attemptId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
