/**
 * Spec R1/R2 — 往期练习记录按主题折叠：组件交互口径锁定。
 * 覆盖默认折叠、组头仅切展开态、独立「再练此主题」按钮、待复盘组内全显、组内删除重算。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/src/context/AuthContext';
import { PracticeWorkspace } from '@/src/components/practice/PracticeWorkspace';
import * as quizStore from '@/src/lib/quiz-store';
import type { QuizHistoryItem } from '@/src/lib/quiz-store';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// 同一主题 3 条（最新为错题 2/5，另有满分与未完成）+ 另一主题 1 条满分单条
const groupItems: QuizHistoryItem[] = [
  {
    attemptId: 'g-1', topic: '量子纠缠机制', difficulty: 'advanced', status: 'completed',
    total: 5, correctCount: 2, createdAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T00:00:00.000Z', review: {},
  },
  {
    attemptId: 'g-2', topic: '量子纠缠机制', difficulty: 'advanced', status: 'completed',
    total: 5, correctCount: 5, createdAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T00:00:00.000Z', review: {},
  },
  {
    attemptId: 'g-3', topic: '量子纠缠机制', difficulty: 'advanced', status: 'in_progress',
    total: 5, correctCount: null, createdAt: '2026-10-01T00:00:00.000Z', completedAt: null, review: {},
  },
  {
    attemptId: 's-1', topic: '梯度下降', difficulty: 'beginner', status: 'completed',
    total: 5, correctCount: 5, createdAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T00:00:00.000Z', review: {},
  },
];

const mockStats = {
  totalAttempts: 4,
  completedAttempts: 3,
  totalQuestions: 15,
  masteredQuestions: 9,
  overallMasteryRate: 0.6,
  byDifficulty: {
    beginner: { totalAttempts: 1, totalQuestions: 5, correctQuestions: 5, masteryRate: 1 },
    intermediate: { totalAttempts: 0, totalQuestions: 0, correctQuestions: 0, masteryRate: 0 },
    advanced: { totalAttempts: 3, totalQuestions: 10, correctQuestions: 4, masteryRate: 0.4 },
  },
  weakPoints: [],
};

beforeEach(() => {
  quizStore.reset();
  quizStore.bindScope('u1');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (url.includes('/api/quiz/stats')) return json(mockStats);
    if (url.includes('/api/quiz/attempts') && method === 'DELETE') return json({ success: true, deleted: 1 });
    if (url === '/api/quiz/attempts') return json({ attempts: groupItems, total: 4, page: 1, hasMore: false });
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

function groupHeader(): HTMLElement {
  return screen.getByText('3 次练习').closest('button') as HTMLElement;
}

describe('PracticeSidebar 主题折叠组', () => {
  it('默认全部折叠：同主题 3 条显示 1 组，异主题 1 条平铺', async () => {
    renderWorkspace();
    await screen.findByText('3 次练习');

    expect(screen.getByText('量子纠缠机制')).toBeInTheDocument();
    expect(screen.getByText('掌握 2/5')).toBeInTheDocument(); // 最新一条的掌握情况
    expect(screen.getByText('梯度下降')).toBeInTheDocument();
    expect(screen.getAllByTitle('查看详情')).toHaveLength(1); // 组内 3 条未渲染
    expect(groupHeader().getAttribute('aria-expanded')).toBe('false');
  });

  it('点组头仅展开/折叠，不切换出题表单', async () => {
    renderWorkspace();
    await screen.findByText('3 次练习');
    const input = screen.getByTestId('quiz-topic-input') as HTMLInputElement;

    fireEvent.click(groupHeader());
    expect(screen.getAllByTitle('查看详情')).toHaveLength(4); // 3 组内 + 1 单条
    expect(screen.getByTestId('quiz-topic-input')).toBeInTheDocument();
    expect(input.value).toBe('');
    expect(groupHeader().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(groupHeader());
    expect(screen.getAllByTitle('查看详情')).toHaveLength(1);
    expect(groupHeader().getAttribute('aria-expanded')).toBe('false');
  });

  it('独立「再练此主题」按钮回填 topic 且不翻转展开态', async () => {
    renderWorkspace();
    await screen.findByText('3 次练习');
    const input = screen.getByTestId('quiz-topic-input') as HTMLInputElement;

    fireEvent.click(screen.getByTitle('再练此主题'));

    expect(input.value).toBe('量子纠缠机制');
    expect(screen.getAllByTitle('查看详情')).toHaveLength(1); // 仍折叠
  });

  it('待复盘：只保留含错题组，组头标错题数，展开显示组内全部记录', async () => {
    renderWorkspace();
    await screen.findByText('3 次练习');

    fireEvent.click(screen.getByRole('button', { name: /^待复盘/ }));

    expect(screen.getByText('3 次练习')).toBeInTheDocument();
    expect(screen.getByText('错题 1')).toBeInTheDocument();
    expect(screen.queryByText('梯度下降')).not.toBeInTheDocument(); // 满分单条被筛掉

    fireEvent.click(groupHeader());
    expect(screen.getAllByTitle('查看详情')).toHaveLength(3); // 组内满分/未完成记录仍在
  });

  it('筛选切换保持展开态', async () => {
    renderWorkspace();
    await screen.findByText('3 次练习');

    fireEvent.click(groupHeader());
    expect(screen.getAllByTitle('查看详情')).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: /^待复盘/ }));
    expect(screen.getAllByTitle('查看详情')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /^全部 \(\d+\)$/ }));
    expect(screen.getAllByTitle('查看详情')).toHaveLength(4);
  });

  it('组内删除按单条生效，剩 1 条时自动退化为单条', async () => {
    renderWorkspace();
    await screen.findByText('3 次练习');
    fireEvent.click(groupHeader());
    expect(screen.getAllByTitle('查看详情')).toHaveLength(4);

    // 删除组内满分记录 g-2（索引 1）
    fireEvent.click(screen.getAllByTitle('删除记录')[1]);
    await screen.findByText('删除这条练习记录？');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.getByText('2 次练习')).toBeInTheDocument());

    // 再删组内最新错题记录 g-1（索引 0），该主题只剩 1 条 → 单条平铺
    fireEvent.click(screen.getAllByTitle('删除记录')[0]);
    await screen.findByText('删除这条练习记录？');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByText('2 次练习')).not.toBeInTheDocument());
    expect(screen.getAllByTitle('查看详情')).toHaveLength(2); // 剩余组内 1 条 + 原单条
  });
});
