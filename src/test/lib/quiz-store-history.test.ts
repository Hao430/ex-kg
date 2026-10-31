/**
 * Spec R1 — 练习历史 store：分页 / 删除回滚 / 清空 / 详情 / 出题单飞。
 * 与 tests/practice-workspace.test.ts（SSR 字符串断言）互补：这里跑真实 RTL/DOM 环境。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as quizStore from '@/src/lib/quiz-store';
import type { QuizHistoryItem, QuizGradeResult } from '@/src/lib/quiz-store';

function item(i: number): QuizHistoryItem {
  return {
    attemptId: `a-${i}`,
    topic: `主题 ${i}`,
    difficulty: 'beginner',
    status: 'completed',
    total: 5,
    correctCount: 4,
    createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
    completedAt: new Date(2026, 0, 1, 0, i).toISOString(),
    review: {},
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  quizStore.reset();
  quizStore.bindScope('u1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('quiz-store 历史分页', () => {
  it('第 1 页用裸 URL，loadMore 追加并按 id 去重', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/quiz/attempts') {
        return json({ attempts: Array.from({ length: 20 }, (_, i) => item(i)), total: 25, page: 1, hasMore: true });
      }
      if (url.includes('page=2')) {
        // 故意包含一条与第 1 页重复的记录
        return json({ attempts: [...Array.from({ length: 4 }, (_, i) => item(20 + i)), item(0)], total: 25, page: 2, hasMore: false });
      }
      return json({ error: 'unexpected' }, 500);
    }));

    await quizStore.refreshHistory();
    expect(calls[0]).toBe('/api/quiz/attempts');

    let view = quizStore.getHistoryView();
    expect(view.items).toHaveLength(20);
    expect(view.total).toBe(25);
    expect(view.hasMore).toBe(true);

    await quizStore.loadMoreHistory();
    view = quizStore.getHistoryView();
    expect(view.items).toHaveLength(24); // 20 + 5 - 1 重复
    expect(new Set(view.items.map((h) => h.attemptId)).size).toBe(24);
    expect(view.hasMore).toBe(false);
    expect(calls.some((u) => u.includes('page=2') && u.includes('limit=20'))).toBe(true);
  });

  it('没有 hasMore 时 loadMore 不发请求', async () => {
    const fetchMock = vi.fn(async () => json({ attempts: [item(1)], total: 1, page: 1, hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);
    await quizStore.refreshHistory();
    await quizStore.loadMoreHistory();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('quiz-store 删除/清空', () => {
  it('删除失败回插原位置；404 视为已删除', async () => {
    let deleteStatus = 500;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') {
        return json({ error: 'x' }, deleteStatus);
      }
      return json({ attempts: [item(1), item(2)], total: 2, page: 1, hasMore: false });
    }));

    await quizStore.refreshHistory();
    expect(await quizStore.removeAttempt('a-1')).toBe(false);
    let view = quizStore.getHistoryView();
    expect(view.items.map((h) => h.attemptId)).toEqual(['a-1', 'a-2']);
    expect(view.historyError).toContain('删除失败');

    deleteStatus = 404;
    expect(await quizStore.removeAttempt('a-1')).toBe(true);
    view = quizStore.getHistoryView();
    expect(view.items.map((h) => h.attemptId)).toEqual(['a-2']);
    expect(view.total).toBe(1);
  });

  it('清空成功后历史与统计归零', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json({ success: true, deleted: 2 });
      return json({ attempts: [item(1), item(2)], total: 2, page: 1, hasMore: false });
    }));

    await quizStore.refreshHistory();
    expect(await quizStore.clearHistory()).toBe(true);
    const view = quizStore.getHistoryView();
    expect(view.items).toHaveLength(0);
    expect(view.total).toBe(0);
    expect(view.hasMore).toBe(false);
  });
});

describe('quiz-store 详情与出题单飞', () => {
  it('fetchAttemptDetail 返回 results/summary', async () => {
    const results: QuizGradeResult[] = [{
      questionId: 'q1', type: 'single', stem: '题干', isCorrect: false,
      choice: 'B', answer: 'A', explanation: '解析', knowledgePoint: 'kp', elapsedMs: 3000, lowConfidence: false,
    }];
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ...item(1), results, summary: { correct: 0, total: 1, accuracy: 0, status: 'completed' },
    })));

    const detail = await quizStore.fetchAttemptDetail('a-1');
    expect(detail?.results[0].choice).toBe('B');
    expect(detail?.results[0].answer).toBe('A');
    expect(detail?.summary.total).toBe(1);
  });

  it('并发 generateQuiz 只发一次请求，body 带 attemptId', async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const p1 = quizStore.generateQuiz({ topic: '主题', difficulty: 'beginner', count: 5 });
    const p2 = quizStore.generateQuiz({ topic: '主题', difficulty: 'beginner', count: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch!(json({
      attemptId: 'a-new',
      questions: [{ id: 'q1', type: 'single', stem: '题干', options: [{ label: 'A', text: 'x' }] }],
      review: {},
    }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const init = (fetchMock.mock.calls[0] as any)[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.attemptId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
