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

const historyItemPerfect = {
  attemptId: 'a-2',
  topic: '梯度下降满分测验',
  difficulty: 'beginner' as const,
  status: 'completed' as const,
  total: 2,
  correctCount: 2,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  review: {},
};

const mockStats = {
  totalAttempts: 2,
  completedAttempts: 2,
  totalQuestions: 4,
  masteredQuestions: 3,
  overallMasteryRate: 0.75,
  byDifficulty: {
    beginner: { totalAttempts: 2, totalQuestions: 4, correctQuestions: 3, masteryRate: 0.75 },
    intermediate: { totalAttempts: 0, totalQuestions: 0, correctQuestions: 0, masteryRate: 0 },
    advanced: { totalAttempts: 0, totalQuestions: 0, correctQuestions: 0, masteryRate: 0 },
  },
  weakPoints: [
    {
      knowledgePoint: '反向传播算法',
      total: 3,
      masteredCount: 1,
      errorCount: 2,
      masteryRate: 0.33,
    },
  ],
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
    if (url.includes('/api/quiz/stats') && method === 'GET') return json(mockStats);
    if (url.includes('/api/quiz/attempts/a-1') && method === 'GET') return json(detail);
    if (url.includes('/api/quiz/attempts') && method === 'DELETE') return json({ success: true, deleted: 1 });
    if (url.includes('/api/quiz/attempts') && method === 'POST') {
      return json({
        attemptId: 'a-new',
        questions: [{ id: 'q_new', type: 'single', stem: '新题', options: [{ label: 'A', text: '选项' }] }],
        review: {},
      });
    }
    if (url === '/api/quiz/attempts') return json({ attempts: [historyItem, historyItemPerfect], total: 2, page: 1, hasMore: false });
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

    fireEvent.click(screen.getAllByTitle('查看详情')[0]);

    await screen.findByText('题目精讲与误区复盘');
    expect(screen.getByText('你的作答：B')).toBeInTheDocument();
    expect(screen.getByText('标准正确答案：')).toBeInTheDocument();
    expect(screen.getByText('你的作答：正确')).toBeInTheDocument();
  });

  it('删除入口经确认后调用 DELETE 并移除记录', async () => {
    renderWorkspace();
    await screen.findByText('注意力机制');

    fireEvent.click(screen.getAllByTitle('删除记录')[0]);
    await screen.findByText('删除这条练习记录？');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(screen.queryByText('注意力机制')).not.toBeInTheDocument();
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'DELETE')).toBe(true);
  });

  it('支持「待复盘」错题筛选：仅展示含错题记录', async () => {
    renderWorkspace();
    await screen.findByText('注意力机制');
    await screen.findByText('梯度下降满分测验');

    // 切换到「待复盘」
    fireEvent.click(screen.getByRole('button', { name: /^待复盘/ }));

    // 注意力机制掌握 1/2（有错题）应保留；梯度下降掌握 2/2 应被过滤
    expect(screen.getByText('注意力机制')).toBeInTheDocument();
    expect(screen.queryByText('梯度下降满分测验')).not.toBeInTheDocument();

    // 切换回「全部」
    fireEvent.click(screen.getByRole('button', { name: /^全部 \(\d+\)$/ }));
    expect(screen.getByText('注意力机制')).toBeInTheDocument();
    expect(screen.getByText('梯度下降满分测验')).toBeInTheDocument();
  });

  it('展示历史薄弱知识点榜单，点击可一键带入「针对攻坚」', async () => {
    renderWorkspace();
    // 渲染薄弱知识点标签
    await screen.findByText('反向传播算法');
    expect(screen.getByText(/失误 2 次/)).toBeInTheDocument();

    // 点击该薄弱知识点卡片
    fireEvent.click(screen.getByText('反向传播算法'));

    // 输入框应自动填入「反向传播算法 专项强化」
    const input = screen.getByTestId('quiz-topic-input') as HTMLInputElement;
    expect(input.value).toBe('反向传播算法 专项强化');
  });

  it('题型偏好选择器支持切换并在生成时提交对应参数', async () => {
    renderWorkspace();
    await screen.findByText('注意力机制');

    // 切换为「仅单选题」
    fireEvent.click(screen.getByRole('button', { name: '仅单选题' }));

    // 输入主题并提交
    const input = screen.getByTestId('quiz-topic-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '量子纠缠' } });
    fireEvent.click(screen.getByRole('button', { name: '生成练习试卷' }));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]: any[]) => String(url).includes('/api/quiz/attempts') && init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const payload = JSON.parse(postCall[1].body);
      expect(payload.questionType).toBe('single');
      expect(payload.topic).toBe('量子纠缠');
    });
  });
});
