/** Spec R1 — 详情 store：失败语义与按 id 直删（深链不能假成功）。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as quizStore from '@/src/lib/quiz-store';

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

describe('fetchAttemptDetailOutcome', () => {
  it('401 / 404 / 500 / 网络异常分别有可区分的 status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)));
    expect(await quizStore.fetchAttemptDetailOutcome('a')).toMatchObject({ ok: false, status: 401 });

    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)));
    expect(await quizStore.fetchAttemptDetailOutcome('a')).toMatchObject({ ok: false, status: 404 });

    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    expect(await quizStore.fetchAttemptDetailOutcome('a')).toMatchObject({ ok: false, status: 'other' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    expect(await quizStore.fetchAttemptDetailOutcome('a')).toMatchObject({ ok: false, status: 'other' });
  });

  it('completed 与 in_progress 都可返回', async () => {
    const base = {
      attemptId: 'a', topic: 't', difficulty: 'beginner' as const, total: 2,
      correctCount: null, createdAt: '', completedAt: null, review: {},
    };
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ...base, status: 'completed', results: [], summary: { correct: 0, total: 0, accuracy: 0, status: 'completed' },
    })));
    expect((await quizStore.fetchAttemptDetailOutcome('a')).ok).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => json({ ...base, status: 'in_progress', questions: [] })));
    expect((await quizStore.fetchAttemptDetailOutcome('a')).ok).toBe(true);
  });
});

describe('removeAttemptById', () => {
  it('记录不在已加载列表时仍发 DELETE，不假成功', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json({ success: true, deleted: 1 });
      return json({ attempts: [], total: 0, page: 1, hasMore: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    await quizStore.refreshHistory();

    expect(await quizStore.removeAttemptById('a-deep-link')).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'DELETE')).toBe(true);
  });

  it('未命中且 DELETE 失败 → false + 错误提示（不再 return true）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json({}, 500);
      return json({ attempts: [], total: 0, page: 1, hasMore: false });
    }));
    await quizStore.refreshHistory();
    expect(await quizStore.removeAttemptById('a')).toBe(false);
    expect(quizStore.getHistoryView().historyError).toContain('删除失败');
  });
});
