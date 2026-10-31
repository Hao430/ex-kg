/**
 * Spec R1 — 练习历史 UI：详情回放与删除入口。
 * 重点锁定「你的作答 = choice，标准答案 = answer」不再混用。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/src/context/AuthContext';
import { PracticeWorkspace } from '@/src/components/practice/PracticeWorkspace';
import * as quizStore from '@/src/lib/quiz-store';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const historyItem = {
  attemptId: 'a-1',
  topic: '注意力机制',
  difficulty: 'beginner' as const,
  status: 'completed' as const,
  total: 2,
  correctCount: 1,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  review: {},
};

const detail = {
  ...historyItem,
  results: [
    {
      questionId: 'q1', type: 'single' as const, stem: '第一题题干', isCorrect: false,
      choice: 'B', answer: 'A', explanation: '解析一', knowledgePoint: 'kp', elapsedMs: 4000, lowConfidence: false,
    },
    {
      questionId: 'q2', type: 'true_false' as const, stem: '第二题题干', isCorrect: true,
      choice: 'true', answer: 'true', explanation: '解析二', knowledgePoint: 'kp', elapsedMs: 4000, lowConfidence: false,
    },
  ],
  summary: { correct: 1, total: 2, accuracy: 0.5, status: 'completed' as const },
};

beforeEach(() => {
  quizStore.reset();
  quizStore.bindScope('u1');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (url.includes('/api/quiz/attempts/a-1') && method === 'GET') return json(detail);
    if (url.includes('/api/quiz/attempts') && method === 'DELETE') return json({ success: true, deleted: 1 });
    if (url === '/api/quiz/attempts') return json({ attempts: [historyItem], total: 1, page: 1, hasMore: false });
    if (url.includes('/api/auth/me')) return json({ user: null }, 401);
    return json({}, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWorkspace() {
  return render(
    <AuthProvider>
      <PracticeWorkspace
        userId="u1"
        user={{ id: 'u1', email: 'u1@example.com', name: 'U1', role: 'user' }}
        theme="light"
        onToggleTheme={() => {}}
        activeProduct="practice"
        onSwitchProduct={() => {}}
        onGoToLanding={() => {}}
      />
    </AuthProvider>,
  );
}

describe('PracticeWorkspace 历史记录 UI', () => {
  it('点击「查看详情」渲染回放，且区分你的作答与标准答案', async () => {
    renderWorkspace();
    await screen.findByText('注意力机制');

    fireEvent.click(screen.getByTitle('查看详情'));

    await screen.findByText('题目精讲与误区复盘');
    expect(screen.getByText('你的作答：B')).toBeInTheDocument();
    expect(screen.getByText('标准正确答案：')).toBeInTheDocument();
    expect(screen.getByText('你的作答：正确')).toBeInTheDocument();
  });

  it('删除入口经确认后调用 DELETE 并移除记录', async () => {
    renderWorkspace();
    await screen.findByText('注意力机制');

    fireEvent.click(screen.getByTitle('删除记录'));
    await screen.findByText('删除这条练习记录？');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(screen.queryByText('注意力机制')).not.toBeInTheDocument();
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'DELETE')).toBe(true);
  });
});
