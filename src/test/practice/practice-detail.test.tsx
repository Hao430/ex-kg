/**
 * Spec R1 — 练习详情页（深链 + 完整回放 + 未完成续答）的 RTL 用例。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AuthProvider } from '@/src/context/AuthContext';
import { PracticeWorkspace } from '@/src/components/practice/PracticeWorkspace';
import * as quizStore from '@/src/lib/quiz-store';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const baseItem = {
  attemptId: 'a-1',
  topic: '注意力机制',
  difficulty: 'beginner' as const,
  total: 2,
  correctCount: 1,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  review: {},
};

const completedDetail = {
  ...baseItem,
  status: 'completed' as const,
  results: [
    {
      questionId: 'q1', type: 'single' as const, stem: '第一题题干', isCorrect: false,
      choice: 'B', options: [
        { label: 'A', text: '选项甲' },
        { label: 'B', text: '选项乙' },
        { label: 'C', text: '选项丙' },
        { label: 'D', text: '选项丁' },
      ],
      answer: 'A', explanation: '解析一', knowledgePoint: '注意力机制', elapsedMs: 4000, lowConfidence: false,
    },
    {
      questionId: 'q2', type: 'single' as const, stem: '第二题题干', isCorrect: true,
      choice: 'C', options: [
        { label: 'A', text: '甲二' }, { label: 'B', text: '乙二' }, { label: 'C', text: '丙二' }, { label: 'D', text: '丁二' },
      ],
      answer: 'C', explanation: '解析二', knowledgePoint: '缩放因子', elapsedMs: 6000, lowConfidence: false,
    },
  ],
  summary: { correct: 1, total: 2, accuracy: 0.5, status: 'completed' as const },
};

const pendingDetail = {
  ...baseItem,
  status: 'in_progress' as const,
  total: 2,
  correctCount: null,
  completedAt: null,
  questions: [
    {
      id: 'q1', type: 'single' as const, stem: '待答第一题', options: [
        { label: 'A', text: '待答选项甲' }, { label: 'B', text: '待答选项乙' },
        { label: 'C', text: '待答选项丙' }, { label: 'D', text: '待答选项丁' },
      ],
    },
    { id: 'q2', type: 'true_false' as const, stem: '待答判断题', options: null },
  ],
};

let detailResponse: { body: unknown; status?: number } = { body: completedDetail };

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || 'GET';
  if (url.includes('/api/auth/me')) return json({ user: null }, 401);
  if (url.includes('/api/quiz/attempts/a-1') && method === 'GET') {
    return json(detailResponse.body, detailResponse.status ?? 200);
  }
  if (url.includes('/api/quiz/attempts') && method === 'DELETE') return json({ success: true, deleted: 1 });
  if (url === '/api/quiz/attempts') {
    return json({ attempts: [baseItem], total: 1, page: 1, hasMore: false });
  }
  return json({}, 404);
});

beforeEach(() => {
  quizStore.reset();
  quizStore.bindScope('u1');
  detailResponse = { body: completedDetail };
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDetail(userId: string | null = 'u1') {
  return render(
    <AuthProvider>
      <PracticeWorkspace
        userId={userId}
        user={userId ? { id: userId, email: 'u1@example.com', name: 'U1', role: 'user' } : null}
        theme="light"
        onToggleTheme={() => {}}
        activeProduct="practice"
        onSwitchProduct={() => {}}
        onGoToLanding={() => {}}
        initialAttemptId="a-1"
      />
    </AuthProvider>,
  );
}

describe('练习详情页', () => {
  it('completed：元信息、选项全文、只看错题筛选', async () => {
    renderDetail();
    await screen.findByText('注意力机制');
    expect(screen.getByText(/总用时 10 秒/)).toBeInTheDocument();
    expect(screen.getByText('选项乙')).toBeInTheDocument();
    expect(screen.getByText('你的作答：B')).toBeInTheDocument();
    expect(screen.getByText('标准正确答案：')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /只看错题/ }));
    await waitFor(() => {
      expect(screen.queryByText('第二题题干')).not.toBeInTheDocument();
      expect(screen.getByText('第一题题干')).toBeInTheDocument();
    });
  });

  it('completed：删除确认后调用 DELETE 并退出详情', async () => {
    renderDetail();
    await screen.findByText('注意力机制');

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await screen.findByText('删除这条练习记录？');
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'DELETE')).toBe(true);
    });
  });

  it('in_progress：只读题目 + 继续作答进入答题态', async () => {
    detailResponse = { body: pendingDetail };
    renderDetail();
    await screen.findByText('待答第一题');
    expect(screen.getAllByText('未完成').length).toBeGreaterThan(0);
    expect(screen.queryByText('试题解析：')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /继续作答/ }));
    await screen.findByText('提交交卷');
    expect(screen.getByText('待答第一题')).toBeInTheDocument();
  });

  it('未登录深链：显示登录 CTA，不渲染详情', async () => {
    renderDetail(null);
    await screen.findByText('请先登录');
    expect(screen.getByRole('button', { name: '登录后查看' })).toBeInTheDocument();
    expect(screen.queryByText('题目精讲与误区复盘')).not.toBeInTheDocument();
  });

  it('404：显示记录不存在', async () => {
    detailResponse = { body: {}, status: 404 };
    renderDetail();
    await screen.findByText('记录不存在');
    expect(screen.getByText('练习记录不存在或已被删除')).toBeInTheDocument();
  });
});
